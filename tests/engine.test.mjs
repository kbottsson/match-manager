import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN,
  SLOTS,
  blockLayout,
  planForecast,
  project,
  canCreditGoal,
  benchList,
  onFieldList,
  stampEvents,
} from '../engine.js';

const CONFIG = { periodCount: 3, periodMinutes: 20, blockMinutes: 7 };
const T0 = 1_700_000_000_000;
const at = (min) => T0 + min * MIN;

const ROSTER = [
  ['p1', 'Leo'], ['p2', 'Sam'], ['p3', 'Noah'], ['p4', 'Elis'], ['p5', 'Hugo'],
  ['p6', 'Axel'], ['p7', 'Vill'], ['p8', 'Omar'], ['p9', 'Isak'],
].map(([id, name]) => ({ id, name }));

let seq = 0;
const ev = (type, atMs, payload = {}) => ({ id: `e${++seq}`, type, atMs, payload });

function lineup(ids) {
  const assignments = {};
  SLOTS.forEach((s, i) => { assignments[s] = ids[i]; });
  return ev('lineup', T0 - MIN, { assignments });
}

/** The nine-row 7/7/6 plan from the design spec wireframe. */
const PLAN_ROWS = [
  ['p1', 'p2', 'p3', 'p8', 'p5', 'p7', 'p9'],
  ['p1', 'p3', 'p6', 'p8', 'p4', 'p7', 'p9'],
  ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'],
  ['p1', 'p2', 'p4', 'p8', 'p5', 'p6', 'p9'],
  ['p1', 'p2', 'p3', 'p8', 'p5', 'p7', 'p9'],
  ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'],
  ['p1', 'p3', 'p6', 'p8', 'p4', 'p7', 'p9'],
  ['p1', 'p2', 'p4', 'p8', 'p5', 'p6', 'p9'],
  ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'],
];

function planCells() {
  const cells = [];
  PLAN_ROWS.forEach((row, blockIndex) => {
    row.forEach((playerId, i) => cells.push({ blockIndex, slot: SLOTS[i], playerId }));
  });
  return cells;
}

function sumPlay(state) {
  return Object.values(state.players).reduce((a, p) => a + p.playMs, 0);
}

function assertInvariant(state) {
  assert.equal(
    Math.abs(sumPlay(state) - SLOTS.length * state.totalRunningMs) <= 1,
    true,
    `Σ playMs ${sumPlay(state)} != 7 x ${state.totalRunningMs}`,
  );
  assert.equal(state.warnInvariant, false);
}

/* ---------------------------------------------------------------- *
 * Plan layout
 * ---------------------------------------------------------------- */

test('blockLayout: 7-minute blocks clip to 7/7/6 per period', () => {
  const blocks = blockLayout(CONFIG);
  assert.equal(blocks.length, 9);
  assert.deepEqual(blocks.map((b) => b.lengthMs / MIN), [7, 7, 6, 7, 7, 6, 7, 7, 6]);
  assert.deepEqual(blocks.map((b) => b.label).slice(0, 3), ['00–07', '07–14', '14–20']);
  assert.deepEqual(blocks.map((b) => b.period), [1, 1, 1, 2, 2, 2, 3, 3, 3]);
  assert.equal(blocks.reduce((a, b) => a + b.lengthMs, 0) / MIN, 60);
});

test('blockLayout: 5-minute blocks give 12 rows', () => {
  const blocks = blockLayout({ ...CONFIG, blockMinutes: 5 });
  assert.equal(blocks.length, 12);
  assert.equal(blocks.every((b) => b.lengthMs === 5 * MIN), true);
});

/* ---------------------------------------------------------------- *
 * Plan forecast (workflow 1)
 * ---------------------------------------------------------------- */

test('planForecast: the 7/7/6 plan is 6 x 46.0, 2 x 42.0, keeper 60.0', () => {
  const f = planForecast(planCells(), CONFIG, ROSTER);
  assert.deepEqual(f.errors, []);
  assert.equal(f.totalMs / MIN, 420);
  assert.equal(f.expectedMs / MIN, 420);
  assert.equal(f.spreadMs / MIN, 4);

  assert.equal(f.players.p1.minMs / MIN, 60);
  assert.equal(f.players.p1.gkMs / MIN, 60);
  for (const id of ['p2', 'p3', 'p4', 'p5', 'p6', 'p7']) {
    assert.equal(f.players[id].minMs / MIN, 46);
  }
  for (const id of ['p8', 'p9']) assert.equal(f.players[id].minMs / MIN, 42);
});

test('planForecast: keeper is excluded from the spread', () => {
  const f = planForecast(planCells(), CONFIG, ROSTER);
  const leo = f.players.p1;
  assert.equal(leo.minMs - leo.gkMs, 0, 'Leo never plays outfield');
});

test('planForecast: per-line split adds up to the total', () => {
  const f = planForecast(planCells(), CONFIG, ROSTER);
  for (const p of Object.values(f.players)) {
    const lines = p.byLine.G + p.byLine.B + p.byLine.M + p.byLine.F;
    assert.equal(lines, p.minMs, `line split for ${p.id}`);
  }
});

test('planForecast: an empty slot is an error', () => {
  const cells = planCells().filter(
    (c) => !(c.blockIndex === 3 && c.slot === 'MM'),
  );
  const f = planForecast(cells, CONFIG, ROSTER);
  const err = f.errors.find((e) => e.kind === 'empty_slots');
  assert.ok(err, 'expected an empty_slots error');
  assert.equal(err.blockIndex, 3);
  assert.deepEqual(err.missing, ['MM']);
});

test('planForecast: a player in two slots of one block is an error', () => {
  const cells = planCells().filter((c) => !(c.blockIndex === 0 && c.slot === 'F'));
  cells.push({ blockIndex: 0, slot: 'F', playerId: 'p2' });
  const f = planForecast(cells, CONFIG, ROSTER);
  assert.ok(f.errors.some((e) => e.kind === 'double_booked' && e.playerId === 'p2'));
});

/* ---------------------------------------------------------------- *
 * Live projection (workflow 2)
 * ---------------------------------------------------------------- */

test('project: credits running time to the seven on the field', () => {
  const events = [lineup(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']), ev('period_start', at(0), { period: 1 })];
  const s = project(events, CONFIG, at(5));

  assert.equal(s.state, 'running');
  assert.equal(s.clockMs, 5 * MIN);
  assert.equal(s.totalRunningMs, 5 * MIN);
  for (const p of Object.values(s.players)) assert.equal(p.playMs, 5 * MIN);
  assertInvariant(s);
});

test('project: STOP then START excludes the paused time', () => {
  const events = [
    lineup(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']),
    ev('period_start', at(0), { period: 1 }),
    ev('clock_stop', at(5)),
    ev('clock_start', at(15)),
  ];
  const s = project(events, CONFIG, at(20));

  assert.equal(s.state, 'running');
  assert.equal(s.clockMs, 10 * MIN, 'clock must freeze for the 10 paused minutes');
  for (const p of Object.values(s.players)) assert.equal(p.playMs, 10 * MIN);
  assertInvariant(s);
});

test('project: a substitution moves the minutes to the incoming player', () => {
  const events = [
    lineup(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']),
    ev('period_start', at(0), { period: 1 }),
    ev('sub', at(5), { off: ['p2'], on: ['p8'], slots: { p8: 'LB' } }),
  ];
  const s = project(events, CONFIG, at(10));

  assert.equal(s.players.p2.playMs, 5 * MIN);
  assert.equal(s.players.p8.playMs, 5 * MIN);
  assert.equal(s.onField.LB, 'p8');
  assertInvariant(s);
});

test('project: voiding the sub restores the original minutes exactly', () => {
  const base = [
    lineup(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']),
    ev('period_start', at(0), { period: 1 }),
  ];
  const sub = ev('sub', at(5), { off: ['p2'], on: ['p8'], slots: { p8: 'LB' } });
  const undo = ev('void', at(6), {});
  undo.voidOf = sub.id;

  const s = project([...base, sub, undo], CONFIG, at(10));
  assert.equal(s.players.p2.playMs, 10 * MIN);
  assert.equal(s.players.p8?.playMs ?? 0, 0, 'voided sub never happened, so p8 has no record');
  assert.equal(s.onField.LB, 'p2');
  assertInvariant(s);
});

test('project: MOVE swaps two slots without changing anyone’s minutes', () => {
  const events = [
    lineup(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']),
    ev('period_start', at(0), { period: 1 }),
    ev('move', at(4), { player: 'p2', from: 'LB', to: 'RB' }),
  ];
  const s = project(events, CONFIG, at(8));
  assert.equal(s.onField.LB, 'p3');
  assert.equal(s.onField.RB, 'p2');
  assert.equal(s.players.p2.playMs, 8 * MIN);
  assert.equal(s.players.p3.playMs, 8 * MIN);
  assertInvariant(s);
});

test('project: goals and assists are attributed, bench goals flagged', () => {
  const events = [
    lineup(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']),
    ev('period_start', at(0), { period: 1 }),
    ev('goal_for', at(3), { scorer: 'p7', assist: 'p4' }),
    ev('goal_against', at(4), {}),
    ev('goal_for', at(5), { scorer: 'p9', assist: null }),
  ];
  const s = project(events, CONFIG, at(6));

  assert.equal(s.score.for, 2);
  assert.equal(s.score.against, 1);
  assert.equal(s.players.p7.goals, 1);
  assert.equal(s.players.p4.assists, 1);
  assert.ok(s.warnings.some((w) => w.kind === 'scorer_off_field' && w.playerId === 'p9'));

  assert.equal(canCreditGoal(s, 'p7'), true);
  assert.equal(canCreditGoal(s, 'p9'), false);
});

test('project: the period keeps running past 20:00 (overrun)', () => {
  const events = [
    lineup(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']),
    ev('period_start', at(0), { period: 1 }),
  ];
  const s = project(events, CONFIG, at(21.5));
  assert.equal(s.clockMs, 21.5 * MIN);
  assertInvariant(s);
});

test('project: period totals accumulate and periods are independent', () => {
  const events = [
    lineup(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']),
    ev('period_start', at(0), { period: 1 }),
    ev('period_end', at(20), { period: 1 }),
    ev('period_start', at(25), { period: 2 }),
  ];
  const s = project(events, CONFIG, at(30));

  assert.equal(s.period, 2);
  assert.equal(s.clockMs, 5 * MIN, 'period 2 clock restarts at zero');
  assert.equal(s.totalRunningMs, 25 * MIN);
  assert.equal(s.periodTotals[0], 20 * MIN);
  assertInvariant(s);
});

test('project: clock_adjust moves the minutes with the clock', () => {
  const events = [
    lineup(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']),
    ev('period_start', at(0), { period: 1 }),
    ev('clock_stop', at(16)),
    ev('clock_adjust', at(16), { period: 1, fromMs: 16 * MIN, toMs: 18 * MIN }),
  ];
  const s = project(events, CONFIG, at(16));

  assert.equal(s.clockMs, 18 * MIN);
  for (const p of Object.values(s.players)) assert.equal(p.playMs, 18 * MIN);
  assertInvariant(s);
});

test('project: a player cannot occupy two slots at once', () => {
  const events = [
    lineup(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']),
    ev('period_start', at(0), { period: 1 }),
    // p2 is already at LB; a malformed sub that moves him without taking anyone off
    ev('sub', at(5), { off: [], on: ['p8'], slots: { p8: 'F' } }),
    ev('move', at(6), { player: 'p2', from: 'LB', to: 'F' }),
  ];
  const s = project(events, CONFIG, at(10));
  const appearances = Object.values(s.onField).filter(Boolean);
  assert.equal(new Set(appearances).size, appearances.length, 'no player twice');
  assertInvariant(s);
});

test('project: minutes are never double counted for one player', () => {
  const events = [
    lineup(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']),
    ev('period_start', at(0), { period: 1 }),
    ev('sub', at(5), { off: ['p7'], on: ['p8'], slots: { p8: 'F' } }),
  ];
  const s = project(events, CONFIG, at(10));
  for (const p of Object.values(s.players)) {
    assert.ok(p.playMs <= s.totalRunningMs + 1, 'nobody exceeds elapsed time');
  }
  assertInvariant(s);
});

test('project: finalize stops the clock for good', () => {
  const events = [
    lineup(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']),
    ev('period_start', at(0), { period: 1 }),
    ev('finalize', at(8), {}),
  ];
  const early = project(events, CONFIG, at(8));
  const later = project(events, CONFIG, at(25));

  assert.equal(early.clockMs, 8 * MIN);
  assert.equal(later.clockMs, 8 * MIN, 'minutes must not accrue after the final whistle');
  assert.equal(later.totalRunningMs, early.totalRunningMs);
  assert.equal(later.status, 'final');
  assertInvariant(later);
});

/* ---------------------------------------------------------------- *
 * The invariant, under abuse
 * ---------------------------------------------------------------- */

test('project: Σ playMs === 7 x running time over random event storms', () => {
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (let round = 0; round < 200; round++) {
    const field = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
    const bench = ['p8', 'p9'];
    const events = [lineup([...field]), ev('period_start', T0, { period: 1 })];

    let t = T0;
    let stopped = false;
    for (let i = 0; i < 40; i++) {
      t += Math.floor(rnd() * 40_000) + 1_000;
      const roll = rnd();

      if (roll < 0.12) {
        events.push(stopped ? ev('clock_start', t) : ev('clock_stop', t));
        stopped = !stopped;
      } else if (roll < 0.85) {
        const offIdx = Math.floor(rnd() * field.length);
        const onIdx = Math.floor(rnd() * bench.length);
        const off = field[offIdx];
        const on = bench[onIdx];
        const slot = SLOTS[offIdx]; // field index and slot index line up
        field[offIdx] = on;
        bench[onIdx] = off;
        events.push(ev('sub', t, { off: [off], on: [on], slots: { [on]: slot } }));
      } else {
        const a = 1 + Math.floor(rnd() * 5);
        const b = 1 + Math.floor(rnd() * 5);
        if (a !== b) {
          events.push(ev('move', t, { player: field[a], from: SLOTS[a], to: SLOTS[b] }));
          [field[a], field[b]] = [field[b], field[a]];
        }
      }
    }

    const s = project(events, CONFIG, t + 30_000);
    assertInvariant(s);
    for (const p of Object.values(s.players)) {
      assert.ok(p.playMs >= 0, 'no negative minutes');
      assert.ok(p.playMs <= s.totalRunningMs + 1, 'nobody plays more than elapsed');
    }
  }
});

/* ---------------------------------------------------------------- *
 * Views
 * ---------------------------------------------------------------- */

test('benchList: fewest minutes first, keeper included like anyone else', () => {
  const events = [
    lineup(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']),
    ev('period_start', at(0), { period: 1 }),
    ev('sub', at(5), { off: ['p1'], on: ['p8'], slots: { p8: 'G' } }),
    ev('sub', at(12), { off: ['p7'], on: ['p9'], slots: { p9: 'F' } }),
  ];
  const s = project(events, CONFIG, at(14));
  const bench = benchList(s, ROSTER);

  assert.deepEqual(bench.map((p) => p.id), ['p1', 'p7']);
  assert.equal(onFieldList(s).length, 7);
});

/* ---------------------------------------------------------------- *
 * Event order
 * ---------------------------------------------------------------- */

test('stampEvents: two writes in the same millisecond stay in order', () => {
  const same = T0;
  const incoming = [
    { id: 'b-second', type: 'sub', atMs: same, payload: {} },
    { id: 'a-first', type: 'sub', atMs: same, payload: {} },
  ];
  const out = stampEvents([], incoming);

  assert.equal(out[0].atMs, same);
  assert.equal(out[1].atMs, same + 1);
  assert.deepEqual(out.map((e) => e.id), ['b-second', 'a-first'],
    'array order is preserved, not re-sorted by id');
});

test('stampEvents: monotonic against what is already stored', () => {
  const existing = [{ id: 'x', type: 'goal_for', atMs: T0 + 10, payload: {} }];
  const out = stampEvents(existing, [{ id: 'y', type: 'sub', atMs: T0, payload: {} }]);

  assert.equal(out[0].atMs, T0 + 11, 'a stale clock cannot rewind the log');
});

test('replay is order-independent: shuffling the log changes nothing', () => {
  const events = [
    lineup(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']),
    ev('period_start', at(0), { period: 1 }),
    ev('goal_for', at(3), { scorer: 'p7', assist: 'p5' }),
    ev('sub', at(7), { off: ['p7'], on: ['p8'], slots: { p8: 'F' } }),
    ev('move', at(9), { player: 'p5', from: 'MM', to: 'RM' }),
    ev('period_end', at(20), { period: 1 }),
  ];
  const base = project(events, CONFIG, at(20));

  const shuffled = [events[4], events[0], events[5], events[2], events[1], events[3]];
  const again = project(shuffled, CONFIG, at(20));

  assert.equal(again.score.for, base.score.for);
  assert.deepEqual(Object.keys(again.players).sort(), Object.keys(base.players).sort());
  for (const id of Object.keys(base.players)) {
    assert.equal(again.players[id].playMs, base.players[id].playMs, `${id} minutes`);
    assert.equal(again.players[id].goals, base.players[id].goals, `${id} goals`);
  }
  assert.deepEqual(again.onField, base.onField);
});

test('same-millisecond events resolve by id, deterministically', () => {
  const line = lineup(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
  const start = { id: 'a-start', type: 'period_start', atMs: at(0), payload: { period: 1 } };
  const first = { id: 'aaaa', type: 'goal_for', atMs: at(1), payload: { scorer: 'p7' } };
  const second = { id: 'zzzz', type: 'goal_for', atMs: at(1), payload: { scorer: 'p5' } };

  // The same objects in two different array orders must replay identically.
  const one = project([line, second, start, first], CONFIG, at(2));
  const two = project([line, first, start, second], CONFIG, at(2));

  assert.equal(one.score.for, 2);
  assert.deepEqual(one.timeline.map((e) => e.id), two.timeline.map((e) => e.id));
});
