/**
 * Seasons & roster migration test.
 *
 * Two things this proves that the main smoke test cannot, because it starts from
 * a seeded model:
 *   1. data written by the pre-season build (single team) migrates losslessly;
 *   2. a season boundary actually behaves like one — carried roster, closed
 *      past season, deliberate unlock, archive with history intact.
 *
 * Run with: node tests/ui.seasons.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8790;
const DBG = 9335;
const BASE = `http://127.0.0.1:${PORT}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ✔ ${name}`);
  else { failures++; console.log(`  ✖ ${name} ${extra}`); }
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'mmseasons-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
  '--window-size=500,961', BASE,
], { stdio: 'ignore' });

function cleanup() {
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DBG}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome devtools never came up');
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  return (method, params = {}) => new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
}

async function main() {
  const page = await target();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = cdp(ws);

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };
  const click = async (sel) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
  const text = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)})?.innerText || ''`);
  const booted = async () => {
    for (let i = 0; i < 40; i++) {
      if (await evaluate("!!document.querySelector('.tabs')")) return;
      await sleep(150);
    }
  };

  await booted();

  // ---- 0. a fresh install has no club at all -----------------------------
  console.log('fresh install');
  ok('empty install offers to start a season',
    (await evaluate("!!document.querySelector('[data-act=\"startseason\"]')")) === true);
  await click('[data-act="startseason"]');
  await sleep(300);
  ok('the season sheet asks for a club name when there is no club',
    (await evaluate("!!document.querySelector('#newclubname')")) === true);
  await evaluate(`(() => { document.querySelector('#newclubname').value = 'Testklubb IF'; return 1 })()`);
  await click('[data-act="createseason"]');
  await sleep(450);
  ok('create actually creates a season on a fresh install',
    (await evaluate("!!document.querySelector('.sheet')")) === false);
  ok('the club appears in the picker', (await text('.picker .pbtn')).includes('Testklubb IF'),
    await text('.picker .pbtn'));
  ok('and the roster is ready to fill',
    (await evaluate("!!document.querySelector('#playerform')")) === true);

  // ---- 1. legacy data, exactly as the previous build wrote it -------------
  await evaluate('localStorage.clear()');
  await evaluate('location.reload()');
  await sleep(900);
  await booted();
  console.log('migration from the single-team build');
  const players = [
    ['Leo', 4], ['Sam', 7], ['Noah', 2], ['Elis', 9], ['Hugo', 3],
    ['Axel', 5], ['Ville', 11], ['Omar', 8], ['Isak', 6],
  ].map(([name, no]) => ({ id: 'p' + no, name, no: String(no) }));

  await evaluate(`(() => {
    const t = { id: 't1', name: 'Uppåkra P16', players: ${JSON.stringify(players)} };
    localStorage.setItem('mm.v1.team', JSON.stringify(t));
    localStorage.setItem('mm.v1.teams', JSON.stringify([
      { id: 'tm1', name: 'P16 A', playerIds: ${JSON.stringify(players.map((p) => p.id))} },
    ]));
    localStorage.setItem('mm.v1.matches', JSON.stringify([
      { id: 'm1', opponent: 'Lunds BK', kickoff: '2026-10-04', periodCount: 3,
        periodMinutes: 20, blockMinutes: 7, status: 'final', teamId: 'tm1' },
    ]));
    localStorage.setItem('mm.v1.events.m1', JSON.stringify([
      { id: 'e1', type: 'lineup', atMs: Date.now() - 60000, clockMs: 0, author: 'coach',
        payload: { assignments: { G: 'p4', LB: 'p7', RB: 'p2', LM: 'p9', MM: 'p3', RM: 'p5', F: 'p11' } } },
      { id: 'e2', type: 'period_start', atMs: Date.now() - 60000, clockMs: 0, author: 'coach', payload: { period: 1 } },
      { id: 'e3', type: 'goal_for', atMs: Date.now() - 50000, clockMs: 10000, author: 'coach',
        payload: { scorer: 'p11', assist: 'p8' } },
      { id: 'e4', type: 'finalize', atMs: Date.now() - 40000, clockMs: 20000, author: 'coach', payload: {} },
    ]));
    return true;
  })()`);
  await evaluate('location.reload()');
  await sleep(900);
  await booted();

  await click('[data-act="tab:squad"]');
  await sleep(300);
  ok('roster survives the migration', (await evaluate("document.querySelectorAll('.prow').length")) === 9,
    String(await evaluate("document.querySelectorAll('.prow').length")));
  ok('club shows in the picker', (await text('.picker .pbtn')).includes('Uppåkra P16'),
    await text('.picker .pbtn'));
  ok('season year shows in the picker', (await text('.picker .pbtn.season')).includes('2026'),
    await text('.picker .pbtn.season'));

  await click('[data-act="tab:teams"]');
  await sleep(300);
  ok('teams carry over', (await text('body')).includes('P16 A'));
  ok('team keeps its nine players', /9 players/i.test(await text('body')));

  await click('[data-act="tab:history"]');
  await sleep(300);
  ok('finished match still in history', (await text('body')).includes('Lunds BK'));
  ok('its score still projects', (await text('.matchrow .sc')).replace(/\s/g, '') === '1–0',
    await text('.matchrow .sc'));
  await click('.matchrow[data-act^="openrecap"]');
  await sleep(350);
  ok('and the recap opens', await evaluate("!!document.querySelector('[data-act^=\"sharepast\"]')"));
  await click('[data-act="closerecap"]');
  await sleep(250);

  // ---- 2. a season boundary ----------------------------------------------
  console.log('starting a new season');
  await click('[data-act="tab:squad"]');
  await sleep(250);
  await click('[data-act="seasonsheet"]');
  await sleep(300);
  ok('season sheet lists 2026 as open', /2026/.test(await text('.sheet')));
  ok('start-a-season is offered', await evaluate("!!document.querySelector('.startnew')"));
  await click('.startnew');
  await sleep(300);
  ok('carry-over is shown before it happens', /9 players/i.test(await text('.sheet')),
    await text('.sheet'));
  await click('[data-act="createseason"]');
  await sleep(450);

  ok('new season is selected', (await text('.picker .pbtn.season')).includes('2027'),
    await text('.picker .pbtn.season'));
  ok('roster carried over', (await evaluate("document.querySelectorAll('.prow').length")) === 9);

  await click('[data-act="seasonsheet"]');
  await sleep(300);
  const seasonsText = await text('.sheet');
  ok('2026 is now closed', /2026/.test(seasonsText) && /closed/i.test(seasonsText), seasonsText);
  const pick2026 = await evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('.sheet [data-act^="pickseason:"]'))
      .find((x) => x.innerText.includes('2026'));
    return b ? b.getAttribute('data-act') : null;
  })()`);
  ok('season sheet exposes 2026', !!pick2026, String(pick2026));
  await click(`[data-act="${pick2026}"]`);
  await sleep(350);
  ok('picking 2026 switches the roster', (await text('.picker .pbtn.season')).includes('2026'));
  ok('closed season shows a read-only banner',
    await evaluate("!!document.querySelector('.lockbar') && !document.querySelector('.lockbar.open')"));
  ok('no add form on a closed season', (await evaluate("!!document.querySelector('#playerform')")) === false);

  // ---- 3. deliberate unlock ----------------------------------------------
  await click('[data-act="unlockseason"]');
  await sleep(300);
  ok('unlock reveals the editing controls',
    (await evaluate("!!document.querySelector('#playerform')")) === true);
  ok('unlocked state is labelled', /unlocked/i.test(await text('.lockbar')), await text('.lockbar'));
  await click('[data-act="lockseason"]');
  await sleep(300);
  ok('re-locking hides them again',
    (await evaluate("!!document.querySelector('#playerform')")) === false);

  // ---- 4. archive mid-season ---------------------------------------------
  console.log('archiving a player');
  await click('[data-act="seasonsheet"]');
  await sleep(300);
  // back to the open season
  const seasonIds = await evaluate(`(Array.from(document.querySelectorAll('.sheet [data-act^="pickseason:"]'))
    .map(b => b.getAttribute('data-act')))`);
  await click(`[data-act="${seasonIds[0]}"]`);
  await sleep(350);
  await evaluate('window.confirm = () => true');

  const before = await evaluate("document.querySelectorAll('.prow:not(.gone)').length");
  await click('.prow[data-act^="playeredit:"]');
  await sleep(300);
  ok('player sheet opens', (await evaluate("!!document.querySelector('#pedit')")) === true);
  await click('[data-act="archiveplayer"]');
  await sleep(450);
  const after = await evaluate("document.querySelectorAll('.prow:not(.gone)').length");
  ok('archived player leaves the active list', after === before - 1, `${before} → ${after}`);
  ok('and appears under Archived', /Archived/i.test(await text('body')));
  ok('with the date they left', /left/i.test(await text('.prow.gone')));

  cleanup();
  console.log(failures ? `\n${failures} failure(s)` : '\nall season checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error('crashed:', err.message); cleanup(); process.exit(1); });
