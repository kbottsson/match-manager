/**
 * engine.js — pure projection of a match event log.
 *
 * No DOM, no storage, no clock of its own: every function takes `nowMs`
 * explicitly so the whole module is deterministic and unit-testable.
 *
 * Core rule (D3/D4): playing time is NEVER stored. It is derived from the
 * event log. Playing time = every minute on the field, goal included.
 */

export const MIN = 60000;

export const SLOTS = ['G', 'LB', 'RB', 'LM', 'MM', 'RM', 'F'];
export const OUTFIELD_SLOTS = ['LB', 'RB', 'LM', 'MM', 'RM', 'F'];

/** Which line a slot belongs to. GK is its own line (D4 keeps it in the total). */
export const LINE_OF = {
  G: 'G',
  LB: 'B', RB: 'B',
  LM: 'M', MM: 'M', RM: 'M',
  F: 'F',
};

const DEFAULTS = { periodCount: 3, periodMinutes: 20, blockMinutes: 7 };

function cfg(config = {}) {
  return { ...DEFAULTS, ...config };
}

/* ------------------------------------------------------------------ *
 * Plan layout
 * ------------------------------------------------------------------ */

/**
 * Blocks per match. With 20-minute periods and 7-minute blocks a period is
 * 7 / 7 / 6 — the last block is clipped to the period end, because three
 * sevens make 21. That clipping is what gives "two substitutions per period".
 */
export function blockLayout(config = {}) {
  const { periodCount, periodMinutes, blockMinutes } = cfg(config);
  const out = [];
  let blockIndex = 0;
  for (let period = 1; period <= periodCount; period++) {
    const perPeriod = Math.ceil(periodMinutes / blockMinutes);
    for (let i = 0; i < perPeriod; i++) {
      const startMin = i * blockMinutes;
      const lengthMin = Math.min(blockMinutes, periodMinutes - startMin);
      if (lengthMin <= 0) continue;
      out.push({
        blockIndex: blockIndex++,
        period,
        startMs: startMin * MIN,
        lengthMs: lengthMin * MIN,
        label: `${pad2(startMin)}–${pad2(startMin + lengthMin)}`,
      });
    }
  }
  return out;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Forecast of planned playing time from a filled-in plan grid.
 *
 * @param cells [{ blockIndex, slot, playerId }]
 * @returns { players, blocks, totalMs, expectedMs, spreadMs, errors }
 */
export function planForecast(cells = [], config = {}, roster = []) {
  const c = cfg(config);
  const blocks = blockLayout(c);
  const errors = [];
  const known = new Set(roster.map((p) => p.id));

  const byBlock = new Map();
  for (const cell of cells) {
    if (!byBlock.has(cell.blockIndex)) byBlock.set(cell.blockIndex, {});
    const row = byBlock.get(cell.blockIndex);
    if (!SLOTS.includes(cell.slot)) {
      errors.push({ kind: 'bad_slot', blockIndex: cell.blockIndex, slot: cell.slot });
      continue;
    }
    if (row[cell.slot] && row[cell.slot] !== cell.playerId) {
      errors.push({ kind: 'slot_taken', blockIndex: cell.blockIndex, slot: cell.slot });
    }
    row[cell.slot] = cell.playerId;
  }

  for (const block of blocks) {
    const row = byBlock.get(block.blockIndex) || {};
    const missing = SLOTS.filter((s) => !row[s]);
    if (missing.length) {
      errors.push({ kind: 'empty_slots', blockIndex: block.blockIndex, missing });
    }
    const seen = new Set();
    for (const slot of SLOTS) {
      const pid = row[slot];
      if (!pid) continue;
      if (seen.has(pid)) {
        errors.push({ kind: 'double_booked', blockIndex: block.blockIndex, playerId: pid });
      }
      seen.add(pid);
      if (roster.length && !known.has(pid)) {
        errors.push({ kind: 'unknown_player', blockIndex: block.blockIndex, playerId: pid });
      }
    }
  }

  const players = {};
  const ensure = (id) => {
    players[id] ??= { id, minMs: 0, gkMs: 0, byLine: { G: 0, B: 0, M: 0, F: 0 } };
    return players[id];
  };

  for (const block of blocks) {
    const row = byBlock.get(block.blockIndex) || {};
    for (const slot of SLOTS) {
      const pid = row[slot];
      if (!pid) continue;
      const p = ensure(pid);
      p.minMs += block.lengthMs;
      if (slot === 'G') p.gkMs += block.lengthMs;
      p.byLine[LINE_OF[slot]] += block.lengthMs;
    }
  }

  const totalMs = Object.values(players).reduce((a, p) => a + p.minMs, 0);
  const expectedMs = SLOTS.length * c.periodCount * c.periodMinutes * MIN;

  // Spread is measured across the outfield rotation only: a full-match keeper
  // is structurally ahead and would distort it (D4 note in the spec).
  const outfield = Object.values(players).filter((p) => p.minMs - p.gkMs > 0);
  const spreadMs = outfield.length
    ? Math.max(...outfield.map((p) => p.minMs)) - Math.min(...outfield.map((p) => p.minMs))
    : 0;

  return { players, blocks, totalMs, expectedMs, spreadMs, errors };
}

/* ------------------------------------------------------------------ *
 * Projection
 * ------------------------------------------------------------------ */

function newPlayer(id) {
  return {
    id,
    playMs: 0,
    gkMs: 0,
    byPeriod: [],
    bySlot: {},
    byLine: { G: 0, B: 0, M: 0, F: 0 },
    stints: [],
    goals: 0,
    assists: 0,
    onNow: false,
    currentStintMs: 0,
    _open: null,
  };
}

/**
 * Replay an event log into match state.
 *
 * @param events  append-only log; events with `voidOf` soft-delete their target
 * @param config  { periodCount, periodMinutes, blockMinutes }
 * @param nowMs   wall clock to project to (pass Date.now() from the UI)
 */
export function project(events = [], config = {}, nowMs = Date.now()) {
  const c = cfg(config);
  const P = c.periodCount;

  const voidedIds = new Set(
    events.map((e) => e.voidOf).filter(Boolean),
  );
  const live = events
    .filter((e) => !voidedIds.has(e.id))
    .sort((a, b) => a.atMs - b.atMs || String(a.id).localeCompare(String(b.id)));

  const st = {
    period: 1,
    state: 'idle', // idle | running | paused | ended
    banked: new Array(P).fill(0),
    onField: {}, // slot -> playerId
    players: {},
    score: { for: 0, against: 0 },
    timeline: [],
    warnings: [],
    status: 'live',
  };

  const ensure = (id) => {
    st.players[id] ??= newPlayer(id);
    const p = st.players[id];
    if (p.byPeriod.length !== P) {
      while (p.byPeriod.length < P) p.byPeriod.push(0);
    }
    return p;
  };

  const totalRunning = () => st.banked.reduce((a, b) => a + b, 0);

  function credit(dtMs) {
    if (st.state !== 'running' || dtMs <= 0) return;
    const i = st.period - 1;
    st.banked[i] += dtMs;
    for (const [slot, pid] of Object.entries(st.onField)) {
      if (!pid) continue;
      const p = ensure(pid);
      p.playMs += dtMs;
      p.byPeriod[i] += dtMs;
      p.bySlot[slot] = (p.bySlot[slot] || 0) + dtMs;
      p.byLine[LINE_OF[slot]] += dtMs;
      if (slot === 'G') p.gkMs += dtMs;
    }
  }

  function closeStint(pid, atClock) {
    const p = st.players[pid];
    if (!p || !p._open) return;
    p.stints.push({ ...p._open, endClockMs: atClock });
    p._open = null;
    p.onNow = false;
  }

  function openStint(pid, slot) {
    const p = ensure(pid);
    if (p._open && p._open.slot === slot) return;
    closeStint(pid, totalRunning());
    p._open = { slot, period: st.period, startClockMs: totalRunning(), atMs: null };
    p.onNow = true;
  }

  function place(slot, pid) {
    if (!SLOTS.includes(slot)) {
      st.warnings.push({ kind: 'bad_slot', slot, playerId: pid });
      return;
    }
    // A player can only occupy one slot: if he is already out there, this is a
    // move, not a second appearance (which would double-count his minutes).
    for (const [other, occupant] of Object.entries(st.onField)) {
      if (occupant === pid && other !== slot) {
        closeStint(pid, totalRunning());
        delete st.onField[other];
      }
    }
    const prev = st.onField[slot];
    if (prev && prev !== pid) closeStint(prev, totalRunning());
    if (!pid) {
      delete st.onField[slot];
      return;
    }
    st.onField[slot] = pid;
    openStint(pid, slot);
  }

  function removePlayer(pid) {
    for (const slot of Object.keys(st.onField)) {
      if (st.onField[slot] === pid) {
        closeStint(pid, totalRunning());
        delete st.onField[slot];
      }
    }
  }

  function onFieldIds() {
    return Object.values(st.onField).filter(Boolean);
  }

  let cursor = null;

  for (const e of live) {
    if (st.state === 'running' && cursor !== null) credit(e.atMs - cursor);

    const p = e.payload || {};
    switch (e.type) {
      case 'lineup': {
        for (const [slot, pid] of Object.entries(p.assignments || {})) {
          place(slot, pid);
        }
        break;
      }

      case 'period_start': {
        st.period = p.period ?? st.period;
        while (st.banked.length < st.period) st.banked.push(0);
        st.state = 'running';
        for (const pid of onFieldIds()) openStint(pid, slotOf(st, pid));
        break;
      }

      case 'clock_stop':
        st.state = 'paused';
        break;

      case 'clock_start':
        if (st.state === 'paused') st.state = 'running';
        break;

      case 'clock_adjust': {
        // Rescue for a clock that drifted from the referee. The delta is applied
        // to the current period and to the seven players on the field, so the
        // Σ invariant stays exact.
        const i = (p.period ?? st.period) - 1;
        const delta = (p.toMs ?? 0) - st.banked[i];
        if (delta !== 0) {
          st.banked[i] += delta;
          for (const [slot, pid] of Object.entries(st.onField)) {
            if (!pid) continue;
            const pl = ensure(pid);
            pl.playMs += delta;
            pl.byPeriod[i] = (pl.byPeriod[i] || 0) + delta;
            pl.bySlot[slot] = (pl.bySlot[slot] || 0) + delta;
            pl.byLine[LINE_OF[slot]] += delta;
            if (slot === 'G') pl.gkMs += delta;
          }
        }
        break;
      }

      case 'period_end':
        st.state = 'ended';
        break;

      case 'sub': {
        for (const pid of p.off || []) removePlayer(pid);
        for (const pid of p.on || []) {
          const slot = (p.slots || {})[pid] || freeSlot(st);
          if (!slot) {
            st.warnings.push({ kind: 'no_free_slot', playerId: pid, atMs: e.atMs });
            continue;
          }
          place(slot, pid);
        }
        break;
      }

      case 'move': {
        const pid = p.player || p.playerId;
        const to = p.to;
        if (!pid || !to) break;
        const fromSlot = slotOf(st, pid);
        if (fromSlot) delete st.onField[fromSlot];
        if (st.onField[to]) {
          const other = st.onField[to];
          if (fromSlot) place(fromSlot, other); // swap
        }
        place(to, pid);
        break;
      }

      case 'goal_for': {
        st.score.for += 1;
        const scorer = ensure(p.scorer);
        scorer.goals += 1;
        if (p.assist) ensure(p.assist).assists += 1;
        if (!onFieldIds().includes(p.scorer)) {
          st.warnings.push({ kind: 'scorer_off_field', playerId: p.scorer, atMs: e.atMs });
        }
        break;
      }

      case 'goal_against':
        st.score.against += 1;
        break;

      case 'roster_change':
        st.available = st.available || {};
        st.available[p.player] = p.available !== false;
        break;

      case 'finalize':
        // The match is over: stop the clock, or every subsequent projection
        // would keep crediting minutes to whoever is on the field.
        st.state = 'ended';
        st.status = 'final';
        break;

      case 'note':
        break;

      default:
        st.warnings.push({ kind: 'unknown_event', type: e.type, atMs: e.atMs });
    }

    st.timeline.push(e);
    cursor = e.atMs;
  }

  // Project forward to `nowMs` without mutating the log.
  if (st.state === 'running' && cursor !== null && nowMs > cursor) {
    credit(nowMs - cursor);
  }

  const totalRunMs = totalRunning();

  // Finalise derived fields.
  for (const p of Object.values(st.players)) {
    const open = p._open;
    p.currentStintMs = open ? totalRunMs - open.startClockMs : 0;
    p.onNow = Boolean(open);
    delete p._open;
  }

  return {
    ...st,
    clockMs: st.banked[st.period - 1] || 0,
    totalRunningMs: totalRunMs,
    periodTotals: [...st.banked],
    warnInvariant:
      Math.abs(
        Object.values(st.players).reduce((a, p) => a + p.playMs, 0) -
          SLOTS.length * totalRunMs,
      ) > 1,
  };
}

function slotOf(state, pid) {
  for (const [slot, id] of Object.entries(state.onField)) {
    if (id === pid) return slot;
  }
  return null;
}

function freeSlot(state) {
  return SLOTS.find((s) => !state.onField[s]) || null;
}

/* ------------------------------------------------------------------ *
 * Convenience views
 * ------------------------------------------------------------------ */

export function onFieldList(state) {
  return SLOTS.filter((s) => state.onField[s]).map((slot) => ({
    slot,
    playerId: state.onField[slot],
    minMs: state.players[state.onField[slot]]?.playMs || 0,
  }));
}

/** Bench, fewest minutes first — the only "recommendation" v1 makes (D9). */
export function benchList(state, roster = []) {
  const playing = new Set(Object.values(state.onField).filter(Boolean));
  return roster
    .filter((p) => !playing.has(p.id))
    .map((p) => ({
      ...p,
      minMs: state.players[p.id]?.playMs || 0,
      onNow: false,
    }))
    .sort((a, b) => a.minMs - b.minMs);
}

/** Guard used by the UI before logging a goal (acceptance criterion 12). */
export function canCreditGoal(state, playerId) {
  return Object.values(state.onField).includes(playerId);
}

export function fmtMin(ms) {
  return (ms / MIN).toFixed(1);
}
