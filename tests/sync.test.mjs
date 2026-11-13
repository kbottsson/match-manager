import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KEYS, LEASE_STALE_MS, POLL_MS, BACKOFF_MS,
  loadPairing, savePairing, clearPairing,
  createApi, createOutbox, createController, nextPollDelay, leaseState, SyncError,
} from '../public/sync.js';

/* ------------------------------------------------------------------ *
 * fakes
 * ------------------------------------------------------------------ */

function mem() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    dump: () => Object.fromEntries(m),
  };
}

const pairing = {
  token: 'tok_abc',
  tenant: { id: 't1', name: 'Uppåkra IF' },
  member: { id: 'm1', name: 'Derek', role: 'owner' },
  deviceId: 'd1',
};

function fakeApi(over = {}) {
  const calls = [];
  const api = {
    calls,
    async postEvents(events) { calls.push(['postEvents', events]); return { data: { seq: 5, accepted: events.length } }; },
    async putDoc(kind, id, body, rev) { calls.push(['putDoc', kind, id, rev]); return { data: { rev: 2 } }; },
    async sync(arg) { calls.push(['sync', arg]); return { data: { seq: 9, events: [], docs: [], lease: [] } }; },
    async lease(matchId, action) { calls.push(['lease', matchId, action]); return { data: { holder: 'd1', name: 'Derek', seenAt: Date.now(), mine: true } }; },
    ...over,
  };
  return api;
}

/* A controller whose timers never fire, so a test cannot leave a poll
 * running and keep the process alive. Tests that care about timing pass
 * their own setTimer/clearTimer. */
const noTimers = { setTimer: () => 0, clearTimer: () => {} };
function ctrl(api, ob, st, extra = {}) {
  return createController({ api, outbox: ob, storage: st, ...noTimers, ...extra });
}

/* ------------------------------------------------------------------ *
 * pairing
 * ------------------------------------------------------------------ */

test('pairing: a stored token round-trips', () => {
  const st = mem();
  savePairing(pairing, st);
  assert.equal(loadPairing(st).tenant.id, 't1');
});

test('pairing: an incomplete record is not a pairing', () => {
  const st = mem();
  st.setItem(KEYS.pairing, JSON.stringify({ token: 'x' }));          // no tenant
  assert.equal(loadPairing(st), null);
  st.setItem(KEYS.pairing, JSON.stringify({ tenant: { id: 't1' } })); // no token
  assert.equal(loadPairing(st), null);
});

test('pairing: clearing removes it, and it cannot be resurrected by a reload', () => {
  const st = mem();
  savePairing(pairing, st);
  clearPairing(st);
  assert.equal(loadPairing(st), null);
});

/* ------------------------------------------------------------------ *
 * rule 1 — an unpaired device never calls a write endpoint (D13)
 * ------------------------------------------------------------------ */

test('unpaired: no token means no network call at all', async () => {
  let hits = 0;
  const api = createApi({ getToken: () => null, fetchImpl: async () => { hits += 1; return new Response('{}'); } });
  await assert.rejects(() => api.postEvents([{ id: 'e1', matchId: 'm1', type: 'goal_for' }]),
    (e) => e instanceof SyncError && e.code === 'not_paired');
  await assert.rejects(() => api.putDoc('match', 'm1', {}, 1), (e) => e.code === 'not_paired');
  await assert.rejects(() => api.sync({ since: 0 }), (e) => e.code === 'not_paired');
  assert.equal(hits, 0, 'fetch must never be reached without a token');
});

test('unpaired: a controller with no pairing pushes nothing', async () => {
  const st = mem();
  const ob = createOutbox(st);
  ob.addEvents('m1', [{ id: 'e1', type: 'goal_for', atMs: 1, payload: {} }]);
  const api = fakeApi();
  const c = ctrl(api, ob, st);
  const res = await c.flush();
  assert.deepEqual(res, { sent: 0, failed: 0 });
  assert.equal(api.calls.length, 0);
  assert.equal(ob.size(), 1, 'the queue is kept, not silently dropped');
});

test('error envelope: a string code from the worker becomes a SyncError code', async () => {
  const api = createApi({
    getToken: () => 'tok',
    fetchImpl: async () => new Response(
      JSON.stringify({ error: 'lease_held', message: 'Someone else is recording.', holder: 'd2', name: 'Amanda' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ),
  });
  const err = await api.lease('m1').catch((e) => e);
  assert.equal(err.code, 'lease_held');
  assert.equal(err.details.name, 'Amanda', 'the holder survives into the details');
});

/* ------------------------------------------------------------------ *
 * outbox
 * ------------------------------------------------------------------ */

test('outbox: documents coalesce, events accumulate', () => {
  const st = mem();
  const ob = createOutbox(st);
  ob.addDoc('plan', 'm1', [{ slot: 1 }]);
  ob.addDoc('plan', 'm1', [{ slot: 2 }]);          // replaces, not appends
  ob.addEvents('m1', [{ id: 'e1', type: 'sub' }]);
  ob.addEvents('m1', [{ id: 'e2', type: 'sub' }]);
  assert.equal(ob.size(), 2);
  const plan = ob.load().find((i) => i.docKind === 'plan');
  assert.deepEqual(plan.body, [{ slot: 2 }]);
  const ev = ob.load().find((i) => i.kind === 'events');
  assert.deepEqual(ev.events.map((e) => e.id), ['e1', 'e2']);
});

test('outbox: the same event id is never queued twice', () => {
  const st = mem();
  const ob = createOutbox(st);
  const e1 = { id: 'e1', type: 'sub' };
  ob.addEvents('m1', [e1]);
  ob.addEvents('m1', [e1]);
  assert.equal(ob.load()[0].events.length, 1);
});

test('outbox: drains model first, then match/plan, then events', () => {
  const st = mem();
  const ob = createOutbox(st);
  ob.addEvents('m1', [{ id: 'e1', type: 'sub' }]);
  ob.addDoc('plan', 'm1', {});
  ob.addDoc('match', 'm1', {});
  ob.addDoc('model', '', {});
  assert.deepEqual(ob.ordered().map((i) => i.docKind || i.kind), ['model', 'match', 'plan', 'events']);
});

test('outbox: survives a reload, because it is only ever in storage', () => {
  const st = mem();
  createOutbox(st).addEvents('m1', [{ id: 'e1', type: 'sub' }]);
  assert.equal(createOutbox(st).size(), 1);
});

test('outbox: partial batch keeps only what did not land', async () => {
  const st = mem();
  const ob = createOutbox(st);
  ob.addEvents('m1', [{ id: 'e1', type: 'sub' }, { id: 'e2', type: 'sub' }]);
  const api = fakeApi({
    async postEvents() { throw new SyncError('network', 'offline'); },
  });
  const c = ctrl(api, ob, st);
  await c.pair(pairing);
  await c.flush();
  assert.equal(ob.size(), 1, 'nothing was lost');
  assert.equal(ob.load()[0].events.length, 2, 'and nothing was falsely marked sent');
});

/* ------------------------------------------------------------------ *
 * poll cadence
 * ------------------------------------------------------------------ */

test('poll: 5 s when healthy and live', () => {
  assert.equal(nextPollDelay({}), POLL_MS);
  assert.equal(POLL_MS, 5000);
});

test('poll: backs off 5 → 10 → 20 → 30 and stays at 30', () => {
  const seq = [1, 2, 3, 4, 5, 9].map((f) => nextPollDelay({ failures: f }));
  assert.deepEqual(seq, [...BACKOFF_MS, 30_000, 30_000]);
});

test('poll: never runs while hidden or when nothing is live', () => {
  assert.equal(nextPollDelay({ hidden: true }), null);
  assert.equal(nextPollDelay({ live: false }), null);
});

/* ------------------------------------------------------------------ *
 * lease
 * ------------------------------------------------------------------ */

test('lease: free, mine, theirs and stale', () => {
  const t0 = 1_000_000;
  assert.equal(leaseState(null, 'd1', t0).state, 'free');
  assert.equal(leaseState({ holder: 'd1', name: 'D', seenAt: t0 }, 'd1', t0).state, 'mine');
  assert.equal(leaseState({ holder: 'd2', name: 'A', seenAt: t0 }, 'd1', t0).state, 'theirs');
  assert.equal(leaseState({ holder: 'd2', name: 'A', seenAt: t0 }, 'd1', t0 + LEASE_STALE_MS - 1).state, 'theirs');
});

test('lease: a recorder keeps its own match even after its heartbeat lapses', () => {
  const t0 = 1_000_000;
  const mine = { holder: 'd1', name: 'Derek', seenAt: t0 };
  assert.equal(leaseState(mine, 'd1', t0 + LEASE_STALE_MS + 5000).state, 'mine');
  assert.equal(leaseState(mine, 'd1', t0 + 600_000).mine, true, 'a phone that slept is still the recorder');
});

test('lease: a sixty-second silence belongs to nobody', () => {
  const t0 = 1_000_000;
  const l = { holder: 'd2', name: 'A', seenAt: t0 };
  assert.equal(leaseState(l, 'd1', t0 + LEASE_STALE_MS).state, 'stale');
  assert.equal(LEASE_STALE_MS, 60_000);
});

test('lease: a held lease blocks the second coach, by name', async () => {
  const st = mem();
  const api = fakeApi({
    async lease() {
      throw new SyncError('lease_held', 'Someone else is recording this match.',
        { holder: 'd2', name: 'Amanda', seenAt: Date.now(), mine: false });
    },
  });
  const c = ctrl(api, createOutbox(st), st);
  await c.pair(pairing);
  c.setIdentity({ deviceId: 'd1' });
  await c.start('m1');
  const got = await c.claim('heartbeat');
  assert.equal(got, null);
  assert.equal(c.state().lease.name, 'Amanda');
  assert.equal(c.state().lease.mine, false);
});

/* ------------------------------------------------------------------ *
 * controller
 * ------------------------------------------------------------------ */

test('drain: documents are pushed before the events that depend on them', async () => {
  const st = mem();
  const ob = createOutbox(st);
  ob.addEvents('m1', [{ id: 'e1', type: 'goal_for' }]);
  ob.addDoc('match', 'm1', { id: 'm1', status: 'live' });
  const api = fakeApi();
  const c = ctrl(api, ob, st);
  await c.pair(pairing);
  await c.flush();
  assert.deepEqual(api.calls.map((x) => x[0]), ['putDoc', 'postEvents']);
  assert.equal(ob.size(), 0);
});

test('drain: writes carry the revision they were based on', async () => {
  const st = mem();
  const ob = createOutbox(st);
  ob.addDoc('plan', 'm1', {}, 7);
  const api = fakeApi();
  const c = ctrl(api, ob, st);
  await c.pair(pairing);
  await c.flush();
  assert.deepEqual(api.calls[0], ['putDoc', 'plan', 'm1', 7]);
});

test('drain: a rejected document is dropped rather than blocking the queue forever', async () => {
  const st = mem();
  const ob = createOutbox(st);
  ob.addDoc('match', 'm1', { status: 'setup' }, 3);
  ob.addEvents('m1', [{ id: 'e1', type: 'sub' }]);
  const api = fakeApi({
    async putDoc() { throw new SyncError('status_regression', 'A match cannot move backwards.'); },
  });
  const c = ctrl(api, ob, st);
  await c.pair(pairing);
  const res = await c.flush();
  assert.equal(res.failed, 1, 'the rejected doc is counted as a failure');
  assert.equal(ob.size(), 0, 'it is dropped, and the events behind it still went');
  assert.ok(api.calls.some((x) => x[0] === 'postEvents'), 'the queue moved past the bad item');
  assert.equal(c.state().lastError, 'status_regression', 'and the reason is kept for the UI');
});

test('drain: a revoked token stops the drain instead of hammering the server', async () => {
  const st = mem();
  const ob = createOutbox(st);
  ob.addEvents('m1', [{ id: 'e1', type: 'sub' }]);
  ob.addDoc('plan', 'm1', {});
  let attempts = 0;
  const api = fakeApi({
    async putDoc() { attempts += 1; throw new SyncError('unauthorized', 'nope'); },
  });
  const c = ctrl(api, ob, st);
  await c.pair(pairing);
  await c.flush();
  assert.equal(attempts, 1);
  assert.equal(ob.size(), 2, 'nothing is discarded on a transport/auth failure');
});

test('pull: advances the cursor and adopts server revisions', async () => {
  const st = mem();
  const api = fakeApi({
    async sync() {
      return { data: { seq: 42, events: [{ id: 'e1', seq: 41 }], docs: [{ kind: 'match', id: 'm1', rev: 9 }], lease: [] } };
    },
  });
  const c = ctrl(api, createOutbox(st), st);
  await c.pair(pairing);
  await c.start('m1');
  const got = await c.pull();
  assert.equal(got.events.length, 1);
  const cursors = JSON.parse(st.getItem(KEYS.cursor));
  assert.equal(cursors.t1, 42);
  const revs = JSON.parse(st.getItem(KEYS.revs));
  assert.equal(revs['match:m1'], 9);
});

test('pull: a 304 is not an error and does not move the cursor', async () => {
  const st = mem();
  const api = fakeApi({ async sync() { return { data: null }; } });
  const c = ctrl(api, createOutbox(st), st);
  await c.pair(pairing);
  const got = await c.pull();
  assert.equal(got, null);
  assert.equal(st.getItem(KEYS.cursor), null);
});

test('timers: going hidden stops the poll, coming back restarts it', async () => {
  const st = mem();
  const timers = [];
  const c = ctrl(fakeApi(), createOutbox(st), st, {
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  await c.pair(pairing);
  await c.start('m1');
  assert.ok(timers.length >= 1, 'a poll was scheduled');
  const before = timers.length;
  c.setHidden(true);
  c.setHidden(false);
  assert.ok(timers.length > before, 'a fresh poll was scheduled on return');
});

test('stop: clears the match and the timers', async () => {
  const st = mem();
  const cleared = [];
  const c = ctrl(fakeApi(), createOutbox(st), st, {
    setTimer: () => 99, clearTimer: (h) => cleared.push(h),
  });
  await c.pair(pairing);
  await c.start('m1');
  c.stop();
  assert.equal(c.state().running, false);
  assert.equal(c.state().matchId, null);
  assert.ok(cleared.length >= 1);
});
