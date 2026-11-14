/**
 * sync.js — the phase-2 client. Optional in every sense: the app is complete
 * without it, and a device without a token never touches the network (D13).
 *
 * Three things live here:
 *
 *   1. Pairing    — the device token, and the rule that no token means no writes.
 *   2. Outbox     — what still has to reach the server, surviving a reload.
 *   3. Controller — when to push, when to poll, and who holds the match lease.
 *
 * The pure parts (drain order, backoff, coalescing) are exported so they can be
 * tested without a browser or a network.
 */

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

const P = 'mm.sync.';
export const KEYS = {
  pairing: P + 'pairing',
  outbox: P + 'outbox',
  cursor: P + 'cursor',       // { [tenant]: seq }
  revs: P + 'revs',           // { 'kind:id': rev }
};

/** A lease with no heartbeat for this long belongs to nobody (D2). */
export const LEASE_STALE_MS = 60_000;
/** Poll cadence while a match is live and the screen is visible. */
export const POLL_MS = 5_000;
/**
 * ...and when nothing is live. A paired device still has to converge on the
 * club: a roster edited on the coach's laptop, a match created for Saturday.
 * Without this, a phone that joins outside a match never learns anything and
 * looks broken, which is exactly what it is.
 */
export const POLL_IDLE_MS = 30_000;
/** Failure backoff, capped. */
export const BACKOFF_MS = [5_000, 10_000, 20_000, 30_000];
/** Eviction order: documents before events, because an event needs its match. */
const ORDER = { model: 0, match: 1, plan: 2, events: 3 };

/* ------------------------------------------------------------------ *
 * storage helpers
 * ------------------------------------------------------------------ */

const readJson = (storage, key, fallback) => {
  try {
    const raw = storage.getItem(key);
    if (raw == null) return fallback;
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch { return fallback; }
};

const writeJson = (storage, key, value) => {
  try { storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
};

/* ------------------------------------------------------------------ *
 * pairing
 * ------------------------------------------------------------------ */

/**
 * The token is the whole permission model on the device. Held in
 * localStorage because this app has no login to hang a session on, and a
 * coach must not be asked to paste a link before every match.
 */
export function loadPairing(storage = globalThis.localStorage) {
  const p = readJson(storage, KEYS.pairing, null);
  if (!p?.token || !p?.tenant?.id) return null;
  return p;
}

export function savePairing(pairing, storage = globalThis.localStorage) {
  return writeJson(storage, KEYS.pairing, pairing);
}

export function clearPairing(storage = globalThis.localStorage) {
  try { storage.removeItem(KEYS.pairing); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ *
 * api
 * ------------------------------------------------------------------ */

export class SyncError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.code = code;
    this.details = details;
  }
}

/**
 * Thin fetch wrapper. Deliberately not clever: one place that knows the
 * envelope, the token header and how to turn an error body into a code.
 */
export function createApi({
  base = '',
  getToken = () => null,
  fetchImpl = (...a) => globalThis.fetch(...a),
  timeoutMs = 10_000,
} = {}) {
  async function call(method, path, { body, headers = {}, token, anon = false } = {}) {
    const t = anon ? null : (token ?? getToken());
    if (!anon && !t) throw new SyncError('not_paired', 'This device is not paired.');

    // A request that never settles would hold the drain open for ever, and the
    // queue behind it would never move. On a touchline, "slow" must degrade to
    // "try again later", never to "stuck".
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;

    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        signal: ctrl ? ctrl.signal : undefined,
        headers: {
          ...(t ? { authorization: 'Bearer ' + t } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new SyncError(err?.name === 'AbortError' ? 'timeout' : 'network',
        err?.message || 'Network error');
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      // The worker answers { error: 'code', message, ...details } — a string
      // code, not an object. Accept both shapes so a lease conflict is never
      // mistaken for an anonymous HTTP failure.
      const e = data && data.error;
      const code = (typeof e === 'string' ? e : e && e.code) || 'http_' + res.status;
      const message = (data && data.message) || (e && typeof e === 'object' && e.message) || `HTTP ${res.status}`;
      throw new SyncError(code, message, (data && typeof data === 'object') ? data : {});
    }
    return { data, etag: res.headers.get('etag') };
  }

  return {
    redeem: (invite, name, device) =>
      call('POST', '/api/auth/redeem', { body: { invite, name, device }, anon: true }),

    /** What the join screen shows before the invite is spent. No auth needed. */
    previewInvite: (invite) =>
      call('GET', `/api/invites/${encodeURIComponent(invite)}/preview`, { anon: true }),

    members: () => call('GET', '/api/members'),

    invite: (role = 'coach', teamId = null) =>
      call('POST', '/api/members/invite', { body: { role, ...(teamId ? { teamId } : {}) } }),

    deviceLink: (label) => call('POST', '/api/devices/link', { body: { label } }),

    retireDevice: (id) => call('DELETE', `/api/devices/${id}`),

    revokeInvite: (id) => call('DELETE', `/api/invites/${id}`),

    revokeMember: (id) => call('DELETE', `/api/members/${id}`),

    me: (token) => (token ? call('GET', '/api/me', { token }) : call('GET', '/api/me')),

    sync: ({ since = 0, revs = '*', etag } = {}) =>
      call('GET', `/api/sync?since=${encodeURIComponent(since)}&revs=${encodeURIComponent(revs)}`,
        { headers: etag ? { 'if-none-match': etag } : {} }),

    postEvents: (events) => call('POST', '/api/events', { body: { events } }),

    getDoc: (kind, id) => call('GET', `/api/docs/${kind}${id ? '/' + id : ''}`),

    putDoc: (kind, id, body, rev) =>
      call('PUT', `/api/docs/${kind}${id ? '/' + id : ''}`, {
        body: { body },
        headers: rev == null ? {} : { 'if-match': String(rev) },
      }),

    lease: (matchId, action = 'heartbeat') =>
      call('POST', `/api/matches/${matchId}/lease`, { body: { action } }),
  };
}

/* ------------------------------------------------------------------ *
 * outbox — survives reload, drains in a safe order
 * ------------------------------------------------------------------ */

/**
 * Items are either:
 *   { kind: 'events', matchId, events: [...] }
 *   { kind: 'doc', docKind: 'model'|'match'|'plan', id, body, rev }
 *
 * Documents coalesce by (docKind, id): only the newest body matters, because a
 * plan is a document, not a log. Events never coalesce — each one is history.
 */
export function createOutbox(storage = globalThis.localStorage, key = KEYS.outbox) {
  const load = () => {
    const raw = readJson(storage, key, []);
    return Array.isArray(raw) ? raw : [];
  };
  const save = (items) => writeJson(storage, key, items);

  return {
    load,
    size: () => load().length,

    addEvents(matchId, events, { rev } = {}) {
      if (!events?.length) return;
      const items = load();
      let item = items.find((i) => i.kind === 'events' && i.matchId === matchId);
      if (!item) { item = { kind: 'events', matchId, events: [], rev }; items.push(item); }
      if (rev != null) item.rev = rev;
      for (const e of events) {
        if (!item.events.some((x) => x.id === e.id)) item.events.push(e);
      }
      save(items);
    },

    addDoc(docKind, id, body, rev = null) {
      const items = load();
      const k = id || '';
      const existing = items.find((i) => i.kind === 'doc' && i.docKind === docKind && (i.id || '') === k);
      if (existing) {
        existing.body = body;
        if (rev != null) existing.rev = rev;
      } else {
        items.push({ kind: 'doc', docKind, id: k, body, rev });
      }
      save(items);
    },

    /** Drops one item after it has been accepted. */
    remove(item) {
      const items = load();
      const i = items.findIndex((x) => x === item
        || (x.kind === item.kind && x.docKind === item.docKind
          && (x.id || '') === (item.id || '') && (x.matchId || '') === (item.matchId || '')));
      if (i !== -1) { items.splice(i, 1); save(items); }
    },

    /** Replaces an item's payload in place — used when only part of a batch landed. */
    update(item, patch) {
      const items = load();
      const i = items.findIndex((x) => (x.kind === item.kind)
        && (x.docKind || '') === (item.docKind || '')
        && (x.id || '') === (item.id || '')
        && (x.matchId || '') === (item.matchId || ''));
      if (i !== -1) { items[i] = { ...items[i], ...patch }; save(items); }
    },

    clear() { save([]); },

    /** Drain order: model, then matches and plans, then events. */
    ordered() {
      return load().slice().sort((a, b) => {
        const ra = a.kind === 'events' ? ORDER.events : (ORDER[a.docKind] ?? 1);
        const rb = b.kind === 'events' ? ORDER.events : (ORDER[b.docKind] ?? 1);
        return ra - rb;
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * poll cadence
 * ------------------------------------------------------------------ */

/**
 * 5 s while live and visible; 5/10/20/30 on consecutive failures; never while
 * the recorder is the one driving (it doesn't poll) or the screen is hidden.
 */
export function nextPollDelay({ failures = 0, live = true, hidden = false } = {}) {
  if (hidden) return null;
  const base = live ? POLL_MS : POLL_IDLE_MS;
  if (failures <= 0) return base;
  if (live) return BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
  return Math.min(base * 2 ** (failures - 1), 300_000);
}

/**
 * free   — nobody is recording
 * mine   — this device holds it, even if its own heartbeat has lapsed (a phone
 *          that slept through three minutes still owns its match; it must not
 *          be locked out of its own recording by its own silence)
 * stale  — someone else held it and stopped; claimable, but only on purpose
 * theirs — someone else is recording right now
 */
export function leaseState(lease, deviceId, now = Date.now()) {
  if (!lease?.holder) return { state: 'free', mine: false, name: null };
  if (deviceId && lease.holder === deviceId) return { state: 'mine', mine: true, name: lease.name };
  const age = now - Number(lease.seenAt || 0);
  if (age >= LEASE_STALE_MS) return { state: 'stale', mine: false, name: lease.name };
  return { state: 'theirs', mine: false, name: lease.name };
}

/* ------------------------------------------------------------------ *
 * controller
 * ------------------------------------------------------------------ */

/**
 * Owns the timers. Everything it does is a consequence of state passed in:
 * the app tells it what is live, visible and pending.
 */
export function createController({
  api,
  outbox,
  storage = globalThis.localStorage,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
  onChange = () => {},
  onArrive = () => {},
} = {}) {
  const state = {
    paired: false,
    deviceId: null,
    member: null,
    tenant: null,
    matchId: null,
    mode: null,             // 'live' while a match is being recorded, 'idle' otherwise
    role: 'coach',          // 'coach' can record; 'view' is read-only by token
    lease: null,
    lastSyncAt: null,
    lastError: null,
    failures: 0,
    pending: 0,
    running: false,
  };

  let tick = null;
  let beat = null;

  const emit = () => onChange({ ...state, pending: outbox.size() });

  function cursor(tenantId) {
    const all = readJson(storage, KEYS.cursor, {}) || {};
    return Number(all[tenantId] || 0) || 0;
  }
  function setCursor(tenantId, seq) {
    const all = readJson(storage, KEYS.cursor, {}) || {};
    all[tenantId] = seq;
    writeJson(storage, KEYS.cursor, all);
  }
  function revs() {
    return readJson(storage, KEYS.revs, {}) || {};
  }
  function setRev(kind, id, rev) {
    const all = revs();
    all[kind === 'model' ? 'model' : `${kind}:${id}`] = rev;
    writeJson(storage, KEYS.revs, all);
  }
  function revOf(kind, id) {
    const all = revs();
    return all[kind === 'model' ? 'model' : `${kind}:${id}`] ?? null;
  }

  /**
   * Pushes everything queued.
   *
   * Runs are serialised on a promise chain rather than guarded by a flag: a
   * flag cleared inside the run and set by the assignment outside it is a race
   * that leaves the queue blocked for ever the first time a flush finds nothing
   * to do. Each caller gets its own link, so a caller that queued something
   * before asking always finds its own writes on the server when it returns.
   */
  let chain = Promise.resolve(null);

  async function drainOnce() {
    let sent = 0;
    let failed = 0;
    for (let pass = 0; pass < 20; pass += 1) {
      const items = outbox.ordered();
      if (!items.length) break;
      let progressed = false;
      let stop = false;

      for (const item of items) {
        try {
          if (item.kind === 'events') {
            if (!item.events.length) { outbox.remove(item); continue; }
            await api.postEvents(item.events.map((e) => ({ ...e, matchId: item.matchId })));
            outbox.remove(item);
            sent += item.events.length;
          } else {
            const res = await api.putDoc(item.docKind, item.id, item.body, item.rev ?? '*');
            setRev(item.docKind, item.id, res.data?.rev);
            outbox.remove(item);
            sent += 1;
          }
          progressed = true;
        } catch (err) {
          // A revoked or unpaired device must stop trying, not spin.
          if (err.code === 'not_paired' || err.code === 401 || err.code === 'unauthorized') {
            state.lastError = err.code;
            stop = true;
            break;
          }
          // A document the server will never accept (rev conflict, status
          // regression) must not wedge the queue: drop it and say so.
          if (err.code === 'rev_conflict' || err.code === 'status_regression') {
            outbox.remove(item);
            state.lastError = err.code;
            failed += 1;
            progressed = true;
            continue;
          }
          failed += 1;
          state.lastError = err.code || 'network';
          stop = true;
          break;
        }
      }
      if (stop || !progressed) break;
    }
    state.pending = outbox.size();
    emit();
    return { sent, failed };
  }

  function flush() {
    if (!state.paired) return Promise.resolve({ sent: 0, failed: 0 });
    const run = chain.then(drainOnce, drainOnce);
    chain = run.catch(() => null);
    return run;
  }

  /** Pulls everything since the cursor. Returns what arrived. */
  async function pull() {
    if (!state.paired) return null;
    const since = cursor(state.tenant.id);
    const res = await api.sync({ since, revs: JSON.stringify(revs()) });
    if (!res.data) return null; // 304
    const { seq, events = [], docs = [], lease = [] } = res.data;
    for (const d of docs) {
      // Adopt the server's revision so the next write doesn't fight it — but
      // only for documents this device is not currently editing.
      setRev(d.kind, d.id, d.rev);
    }
    if (seq) setCursor(state.tenant.id, seq);
    state.lastSyncAt = now();
    state.failures = 0;
    return { events, docs, lease };
  }

  function schedule(ms) {
    if (tick) { clearTimer(tick); tick = null; }
    if (ms == null || !state.running || !state.paired) return;
    tick = setTimer(async () => {
      tick = null;
      if (!state.running) return;
      try {
        const got = await pull();
        state.failures = 0;
        emit();
        if (got) onArrive(got);
      } catch (err) {
        state.failures += 1;
        state.lastError = err.code || 'network';
        emit();
      }
      schedule(nextPollDelay({ failures: state.failures, live: state.mode === 'live', hidden: false }));
    }, ms);
  }

  return {
    state: () => ({ ...state, pending: outbox.size() }),

    async pair(pairing) {
      state.paired = true;
      state.tenant = pairing.tenant;
      state.member = pairing.member;
      state.deviceId = pairing.deviceId || pairing.member?.deviceId || null;
      emit();
    },

    setIdentity({ deviceId, member, tenant, role }) {
      state.deviceId = deviceId ?? state.deviceId;
      state.member = member ?? state.member;
      state.tenant = tenant ?? state.tenant;
      state.role = role ?? state.role;
      state.paired = !!state.tenant?.id;
      emit();
    },

    /** Begin pushing and polling for a match. */
    async start(matchId) {
      state.matchId = matchId;
      state.mode = 'live';
      state.running = true;
      emit();
      await flush();
      schedule(nextPollDelay({ failures: 0, live: true, hidden: false }));
    },

    /** Keep the club fresh when nothing is being recorded: every 30 s. */
    startIdle() {
      state.mode = 'idle';
      state.matchId = null;
      state.running = true;
      emit();
      schedule(nextPollDelay({ failures: 0, live: false, hidden: false }));
    },

    stop() {
      state.running = false;
      state.matchId = null;
      state.mode = null;
      if (tick) { clearTimer(tick); tick = null; }
      if (beat) { clearTimer(beat); beat = null; }
      emit();
    },

    /** Recorder only: claim or keep the lease. */
    async claim(action = 'heartbeat') {
      if (!state.paired || !state.matchId) return null;
      try {
        const res = await api.lease(state.matchId, action);
        state.lease = res.data;
        emit();
        return res.data;
      } catch (err) {
        if (err.code === 'lease_held') {
          state.lease = { ...(err.details || {}), mine: false };
          emit();
          return null;
        }
        throw err;
      }
    },

    async release() {
      if (!state.paired || !state.matchId) return;
      try { await api.lease(state.matchId, 'release'); } catch { /* leaving anyway */ }
      state.lease = null;
      emit();
    },

    /**
     * Heartbeat while recording, every 25 s — comfortably inside the 60 s stale
     * window. The first beat comes quickly: a claim can fail because the match
     * document has not reached the server yet, and losing the pen to a phone
     * that merely opened the screen a second later would be wrong.
     */
    startHeartbeat(ms = 25_000, firstMs = 2_500) {
      if (beat) clearTimer(beat);
      const step = async () => {
        if (!state.running || !state.paired || !state.matchId) return;
        // Someone else's lease — fresh or gone quiet — is theirs to give up.
        // Claiming a quiet one would be a silent takeover, so we stop asking
        // and leave it to the coach (the screen offers it explicitly).
        const theirs = state.lease && !state.lease.mine;
        if (!theirs) {
          try { await this.claim('heartbeat'); } catch { /* retried on the next beat */ }
        }
        beat = setTimer(step, ms);
      };
      beat = setTimer(step, Math.min(firstMs, ms));
    },

    stopHeartbeat() { if (beat) { clearTimer(beat); beat = null; } },

    flush,
    pull,

    /** Force a poll, e.g. on foreground or on `online`. */
    async now() {
      if (!state.running) return null;
      try {
        const got = await pull();
        state.failures = 0;
        emit();
        if (got) onArrive(got);
        return got;
      } catch (err) {
        state.failures += 1;
        state.lastError = err.code || 'network';
        emit();
        return null;
      }
    },

    /** The page went to the background: stop the timer, keep the state. */
    setHidden(hidden) {
      if (!state.running) return;
      if (hidden) { if (tick) { clearTimer(tick); tick = null; } }
      else schedule(nextPollDelay({ failures: state.failures, live: state.mode === 'live', hidden: false }));
    },
  };
}
