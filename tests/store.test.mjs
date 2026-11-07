import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore, uid } from '../store.js';

function fakeStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    [Symbol.iterator]: () => map.keys(),
    _dump: () => Object.fromEntries(map),
  };
}

const MATCH = {
  id: 'm1', opponent: 'Lunds BK', kickoff: '2026-11-08T10:00:00Z',
  periodCount: 3, periodMinutes: 20, blockMinutes: 7, status: 'live',
};

const ev = (type, payload = {}) => ({ id: uid(), type, atMs: 1_700_000_000_000, payload });

test('store: team and match round-trip', () => {
  const s = createStore(fakeStorage());
  assert.equal(s.loadTeam(), null);
  s.saveTeam({ id: 't1', name: 'Uppåkra P16' });
  assert.equal(s.loadTeam().name, 'Uppåkra P16');

  s.saveMatch(MATCH);
  assert.equal(s.listMatches().length, 1);
  assert.equal(s.loadMatch('m1').opponent, 'Lunds BK');

  s.saveMatch({ ...MATCH, status: 'final' });
  assert.equal(s.listMatches().length, 1, 'saving an existing match must not duplicate it');
  assert.equal(s.loadMatch('m1').status, 'final');
});

test('store: appending events is durable and ordered', () => {
  const storage = fakeStorage();
  const a = createStore(storage);
  const e1 = ev('period_start', { period: 1 });
  const e2 = ev('sub', { off: ['p2'], on: ['p8'] });
  assert.ok(a.appendEvent('m1', e1));
  assert.ok(a.appendEvent('m1', e2));

  // A second store on the same storage sees them — this is the "phone died" path.
  const b = createStore(storage);
  assert.deepEqual(b.loadEvents('m1').map((e) => e.type), ['period_start', 'sub']);
});

test('store: void appends rather than deleting', () => {
  const s = createStore(fakeStorage());
  const target = ev('sub', { off: ['p2'], on: ['p8'] });
  s.appendEvent('m1', target);
  const v = s.voidEvent('m1', target.id);

  const all = s.loadEvents('m1');
  assert.equal(all.length, 2, 'the original event must survive');
  assert.equal(all[0].id, target.id);
  assert.equal(all[1].voidOf, target.id);
  assert.equal(v.voidOf, target.id);
});

test('store: plan is stored per match and is not part of the event log', () => {
  const s = createStore(fakeStorage());
  s.savePlan('m1', [{ blockIndex: 0, slot: 'G', playerId: 'p1' }]);
  assert.equal(s.loadPlan('m1').length, 1);
  assert.equal(s.loadEvents('m1').length, 0);
});

test('store: corrupt storage degrades instead of throwing', () => {
  const storage = fakeStorage();
  storage.setItem('mm.v1.events.m1', '{not json');
  storage.setItem('mm.v1.matches', '"wrong shape"');
  const s = createStore(storage);
  assert.deepEqual(s.loadEvents('m1'), []);
  assert.equal(s.loadMatch('m1'), null);
});

test('store: a refused write is reported, not swallowed silently', () => {
  const storage = fakeStorage();
  storage.setItem = () => { throw new Error('quota'); };
  const s = createStore(storage);
  assert.equal(s.appendEvent('m1', ev('note')), null);
});

test('store: export/import round-trips a whole season', () => {
  const s = createStore(fakeStorage());
  s.saveTeam({ id: 't1', name: 'Uppåkra P16' });
  s.saveMatch(MATCH);
  s.savePlan('m1', [{ blockIndex: 0, slot: 'G', playerId: 'p1' }]);
  s.appendEvent('m1', ev('goal_for', { scorer: 'p7' }));

  const dump = s.exportAll();
  const fresh = createStore(fakeStorage());
  fresh.importAll(dump);

  assert.equal(fresh.loadTeam().name, 'Uppåkra P16');
  assert.equal(fresh.loadEvents('m1').length, 1);
  assert.equal(fresh.loadPlan('m1').length, 1);
  assert.equal(fresh.loadEvents('m1')[0].payload.scorer, 'p7');
});

test('store: refuses an import from a different schema version', () => {
  const s = createStore(fakeStorage());
  assert.equal(s.importAll({ v: 99 }), false);
});

test('uid: produces unique ids', () => {
  const ids = new Set(Array.from({ length: 500 }, () => uid()));
  assert.equal(ids.size, 500);
});
