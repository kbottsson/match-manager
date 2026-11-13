/**
 * UI smoke test — drives the real page in headless Chrome over CDP.
 * Not part of `npm test` (needs a browser); run with: node tests/ui.smoke.mjs
 *
 * Catches what unit tests cannot: broken data-act wiring, sheets that never
 * open, buttons that do nothing.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8788;
const DBG = 9333;
const BASE = `http://127.0.0.1:${PORT}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ✔ ${name}`);
  else { failures++; console.log(`  ✖ ${name} ${extra}`); }
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { stdio: 'ignore', cwd: 'public' });
const profile = mkdtempSync(join(tmpdir(), 'mmui-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
  '--window-size=500,961', `${BASE}?seed=1`,
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

  // give the module graph time to boot
  for (let i = 0; i < 40; i++) {
    if (await evaluate("document.querySelectorAll('.row').length")) break;
    await sleep(150);
  }

  console.log('live screen');
  ok('seven on-field rows', (await evaluate("document.querySelectorAll('.view .list .row').length")) === 9);
  // The seeded match starts 7.2 minutes ago, so the clock is 07:12 plus however
  // long this run took to boot — assert the range, not the exact second.
  const seededClock = await text('[data-clock]');
  const clockSecs = (() => {
    const m = seededClock.match(/(\d+):(\d+)/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  })();
  ok('clock reflects the seeded 7.2 minutes of play', clockSecs >= 425 && clockSecs <= 450, seededClock);
  ok('score 2–1', (await text('.score')).replace(/\s/g, '') === '2–1');
  ok('goal buttons only on on-field rows',
    (await evaluate("document.querySelectorAll('.row .rbtn.goal').length")) === 7);

  console.log('goal → assist → save');
  ok('goal button clickable', await click('[data-act^="goal:"]'));
  await sleep(120);
  ok('assist sheet opened', (await text('.sheet')).includes('Assist'));
  ok('scorer pinned in sheet', (await text('.sheet .picked')).length > 0);
  ok('no-assist button present', await evaluate("!!document.querySelector('.sheet [data-act=\"assist:none\"]')"));
  await click('.sheet [data-act="assist:none"]');
  await sleep(120);
  ok('sheet closed after save', (await evaluate("!document.querySelector('.sheet')")) === true);
  ok('score incremented to 3', (await text('.score')).replace(/\s/g, '') === '3–1');
  ok('undo toast shown', await evaluate("!!document.querySelector('.toast')"));

  console.log('substitution from an on-field row');
  await click('.row .rbtn:not(.goal)');
  await sleep(120);
  ok('sub sheet opened', (await text('.sheet')).includes('Who comes on') ||
    (await text('.sheet')).toLowerCase().includes('comes on'));
  const benchBefore = await evaluate("document.querySelectorAll('.view .list .row').length");
  await click('.sheet .gbtn');
  await sleep(150);
  ok('sub applied (sheet closed)', (await evaluate("!document.querySelector('.sheet')")) === true);
  ok('still nine rows', (await evaluate("document.querySelectorAll('.view .list .row').length")) === benchBefore);

  console.log('position change');
  await click('.row .nm');
  await sleep(120);
  ok('player sheet opened', (await text('.sheet')).length > 0);
  ok('change-position action present', await evaluate("!!document.querySelector('[data-act^=\"position:\"]')"));
  await click('[data-act^="position:"]');
  await sleep(120);
  ok('slot grid opened', (await evaluate("document.querySelectorAll('.sheet .gbtn').length")) >= 6);
  await click('.sheet .gbtn:not(.cur)');
  await sleep(150);
  ok('move applied', (await evaluate("!document.querySelector('.sheet')")) === true);

  console.log('undo');
  const before = await text('.score');
  await click('[data-act="undo:last"]');
  await sleep(150);
  ok('undo ran without error', (await text('.score')).length > 0, before);

  console.log('clock control');
  const clockBefore = await text('[data-clock]');
  ok('stop button present', await evaluate("!!document.querySelector('[data-act=\"clock:stop\"]')"));
  await click('[data-act="clock:stop"]');
  await sleep(400);
  const clockAfter = await text('[data-clock]');
  ok('clock frozen after stop', clockBefore !== '' && clockAfter !== '', `${clockBefore} → ${clockAfter}`);
  ok('start button appears when paused', await evaluate("!!document.querySelector('[data-act=\"clock:start\"]')"));

  console.log('home and back');
  await click('[data-act="home"]');
  await sleep(200);
  ok('home screen shown with match in progress', /in progress/i.test(await text('body')));
  ok('resume button present', await evaluate("!!document.querySelector('[data-act=\"resume\"]')"));
  await click('[data-act="resume"]');
  await sleep(200);
  ok('back on the live screen', await evaluate("!!document.querySelector('[data-act=\"periodsheet\"]')"));
  ok('tab switching from home stays on the roster, not back in the match', await (async () => {
    await click('[data-act="home"]');
    await sleep(200);
    await click('[data-act="tab:squad"]');
    await sleep(250);
    const onRoster = await evaluate("!!document.querySelector('.tabs') && !!document.querySelector('#playerform')");
    await click('[data-act="tab:match"]');
    await sleep(200);
    await click('[data-act="resume"]');
    await sleep(200);
    return onRoster;
  })());

  console.log('period change');
  const periodBefore = parseInt((await text('[data-act="periodsheet"]')).match(/\d+/)[0], 10);
  await click('[data-act="periodsheet"]');
  await sleep(150);
  ok('period sheet opened', await evaluate("!!document.querySelector('[data-act=\"endperiod\"]')"));
  await click('[data-act="endperiod"]');
  await sleep(200);
  ok('end period returns the start control',
    await evaluate("!!document.querySelector('[data-act=\"clock:start\"]')"));
  const barText = (await text('.actions')).replace(/\s+/g, ' ');
  ok(`next period offered (${periodBefore + 1})`, barText.includes(String(periodBefore + 1)), barText);
  await click('[data-act="clock:start"]');
  await sleep(400);
  const clock2 = (await text('[data-clock]')).trim();
  ok('new period clock restarted near zero', /^00:0/.test(clock2), clock2);
  const periodAfter = parseInt((await text('[data-act="periodsheet"]')).match(/\d+/)[0], 10);
  ok('period advanced by exactly one', periodAfter === periodBefore + 1, `${periodBefore} → ${periodAfter}`);

  console.log('end the match early');
  await evaluate("window.confirm = () => true");
  await click('[data-act="periodsheet"]');
  await sleep(150);
  ok('period sheet offers End match', await evaluate("!!document.querySelector('[data-act=\"finalize\"]')"));
  await click('[data-act="finalize"]');
  await sleep(400);
  ok('recap shown after ending early', /final score/i.test(await text('body')));
  ok('minutes stopped at the final whistle',
    !(await evaluate("!!document.querySelector('[data-clock]')")));

  await click('[data-act="done"]');
  await sleep(250);
  ok('nothing planned → the new-match form is offered directly',
    await evaluate("!!document.querySelector('#matchform')"));

  console.log('plan a match in advance');
  await evaluate(`(() => {
    const f = document.querySelector('#matchform');
    f.opponent.value = 'Högaborgs BK';
    f.kickoff.value = '2026-11-16';
    return true;
  })()`);
  await click('[data-act="creatematch"]');
  await sleep(350);
  ok('planner opened for the new match', await evaluate("!!document.querySelector('.ptable')"));
  ok('plan header offers Save, not Cancel',
    await evaluate("!!document.querySelector('[data-act=\"saveplan\"]') && !document.querySelector('header [data-act=\"deletematch\"]')"));
  ok('squad row lists the roster', (await evaluate("document.querySelectorAll('.chiprow .tog').length")) >= 9);

  await click('[data-act="autoplan"]');
  await sleep(350);
  const filled = await evaluate("document.querySelectorAll('.ptable tr:not(.bench) td.cell:not(.empty)').length");
  ok('auto-fill filled every slot', filled === 63, String(filled));

  await evaluate("document.querySelectorAll('.chiprow .tog')[0].click()");
  await sleep(250);
  ok('unticking a player updates the squad count',
    /8 of 9/i.test(await text('.squadhead')), await text('.squadhead'));
  const filledAfter = await evaluate("document.querySelectorAll('.ptable tr:not(.bench) td.cell:not(.empty)').length");
  ok('their plan cells were cleared', filledAfter < filled, `${filled} → ${filledAfter}`);

  await click('[data-act="saveplan"]');
  await sleep(300);
  ok('Save returns home and confirms', /saved/i.test(await text('body')));
  ok('new match listed under Upcoming', (await text('body')).includes('Högaborgs BK'));
  ok('"plan another" offered alongside it',
    await evaluate("!!document.querySelector('[data-act=\"newmatch\"]')"));

  console.log('teams');
  await click('[data-act="tab:teams"]');
  await sleep(250);
  ok('teams tab lists the seeded team', (await text('body')).includes('P16 A'));
  ok('team row shows its player count', /9 players/i.test(await text('body')), await text('.card'));

  await click('[data-act="newteam"]');
  await sleep(300);
  ok('team editor opened', await evaluate("!!document.querySelector('#teamnameform')"));
  await evaluate(`(() => { document.querySelector('#teamnameform [name="teamname"]').value = 'P16 B'; return 1 })()`);
  const togs = await evaluate("document.querySelectorAll('.card .chiprow .tog').length");
  ok('roster players offered for selection', togs >= 9, String(togs));
  await evaluate("document.querySelectorAll('.card .chiprow .tog')[0].click()");
  await evaluate("document.querySelectorAll('.card .chiprow .tog')[1].click()");
  await sleep(200);
  ok('picking players updates the count', /2\/9/.test(await text('body')), await text('.card'));
  await click('[data-act="saveteam2"]');
  await sleep(300);
  ok('new team listed', (await text('body')).includes('P16 B'));
  ok('team carries its two players', /2 players/i.test(await text('body')));

  await click('[data-act="tab:match"]');
  await sleep(200);
  await click('[data-act="newmatch"]');
  await sleep(250);
  ok('match form asks which team',
    await evaluate("document.querySelectorAll('select[name=\"teamid\"] option').length") === 2);

  console.log('next change strip + plan sheet');
  // The teams section left a new-match form open.
  await evaluate(`(() => {
    const f = document.querySelector('#matchform');
    f.opponent.value = 'Strip Test IF';
    return true;
  })()`);
  await click('[data-act="creatematch"]');
  await sleep(350);
  await click('[data-act="autoplan"]');
  await sleep(350);
  await click('[data-act="startmatch"]');
  await sleep(450);

  ok('live screen is up', await evaluate("!!document.querySelector('.row')"));
  ok('next-change strip is shown', await evaluate("!!document.querySelector('.nxt')"));
  ok('strip carries a countdown', /^\d{1,2}:\d{2}$/.test((await text('.nxt .cd')).trim()),
    await text('.nxt .cd'));
  ok('strip names who goes off and on', (await text('.nxt .chg')).includes('→'),
    await text('.nxt .chg'));

  // What the plan asks for at the next boundary, read straight from the sheet.
  await click('[data-act="plansheet"]');
  await sleep(300);
  ok('plan chip opens the plan sheet', await evaluate("!!document.querySelector('.sheet.tall .ptable')"));
  ok('current block is marked in the grid',
    await evaluate("document.querySelectorAll('.ptable th.now').length") === 1);
  ok('the plan sheet is read-only',
    await evaluate("document.querySelectorAll('.ptable td.cell[data-act]').length") === 0);
  const nextCol = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.sheet.tall .ptable tr')]
      .filter(r => r.querySelector('td.lbl') && !r.classList.contains('bench'));
    return rows.map(r => {
      const cells = r.querySelectorAll('td.cell');
      const t = cells[1];
      return t ? t.innerText.trim() : '';
    });
  })()`);
  const plannedNames = nextCol
    .filter((v) => v && v !== '+')
    .join(',')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();

  await click('[data-act="sheet:close"]');
  await sleep(250);

  const readPitch = `Array.from(document.querySelectorAll('.list .row .nm')).slice(0,7).map(function(n){
    return (n.textContent || '').replace(/[0-9]+$/, '').trim();
  })`;
  const pitchBefore = await evaluate(readPitch) || [];

  await click('[data-act="applyplan"]');
  await sleep(400);

  ok('the toast reports both changes', /2 changes applied/i.test(await text('.toast')), await text('.toast'));

  const onField = await evaluate(readPitch) || [];
  ok('Apply puts exactly the planned players on the pitch',
    JSON.stringify([...onField].sort()) === JSON.stringify(plannedNames),
    `pitch=${onField.sort().join(',')} plan=${plannedNames.join(',')}`);
  // Two sub events written in the same millisecond must still be ordered.
  const stamped = await evaluate(`(() => {
    return Object.keys(localStorage).filter(function(k){ return k.indexOf('mm.v1.events.') === 0; })
      .every(function(k){
        const evs = JSON.parse(localStorage.getItem(k) || '[]');
        const t = evs.map(function(e){ return Number(e.atMs) || 0; });
        return t.every(function(v, i){ return i === 0 || v > t[i - 1]; });
      });
  })()`);
  ok('every event log is strictly ordered in time', stamped === true, String(stamped));

  ok('strip advances to the next boundary (or clears)',
    (await evaluate("!!document.querySelector('.nxt')")) === false
    || (await text('.nxt .chg')).includes('→'));
  ok('strip is blank once the period plan is done',
    (await evaluate("!!document.querySelector('.nxt')")) === false);

  await click('.toast button');
  await sleep(400);
  const pitchUndone = await evaluate(readPitch) || [];
  ok('one Undo reverses the whole Apply',
    JSON.stringify([...pitchUndone].sort()) === JSON.stringify([...pitchBefore].sort()),
    `undone=${pitchUndone.join(',')} before=${pitchBefore.join(',')}`);

  console.log('missed boundary');
  // Jump the clock to 08:00 — two minutes past the first boundary — via the
  // exact correction behind the period sheet.
  await click('[data-act="periodsheet"]');
  await sleep(200);
  await click('[data-act="clockadjust"]');
  await sleep(200);
  await evaluate(`(() => { document.querySelector('.setexact [name="exactmin"]').value = '8'; return 1 })()`);
  await click('[data-act="setexact"]');
  await sleep(400);
  ok('clock can be set exactly, to match the referee', /^08:0/.test(await text('.clock')), await text('.clock'));
  ok('a change you did not make stays on screen', await evaluate("!!document.querySelector('.nxt.late')"));
  ok('it is labelled as overdue, not as upcoming',
    /overdue/i.test(await text('.nxt .lab')), await text('.nxt .lab'));
  ok('it still names the pair you owe', (await text('.nxt .chg')).includes('→'), await text('.nxt .chg'));

  await click('[data-act="applyplan"]');
  await sleep(400);
  ok('applying the overdue change clears it', (await evaluate("!!document.querySelector('.nxt.late')")) === false);

  console.log('reopen a finished match from history');
  await click('[data-act="home"]');
  await sleep(300);
  await click('[data-act="tab:history"]');
  await sleep(300);
  const rows = await evaluate("document.querySelectorAll('.matchrow[data-act^=\"openrecap\"]').length");
  ok('history lists finished matches', rows >= 1, String(rows));
  const historyOpp = await text('.matchrow .opp');
  const historyScore = await text('.matchrow .sc');

  await click('.matchrow[data-act^="openrecap"]');
  await sleep(350);
  ok('the recap reopens from history', await evaluate("!!document.querySelector('[data-act^=\"sharepast\"]')"));
  ok('it is the same match', (await text('header')).includes(historyOpp.trim()),
    `${await text('header')} vs ${historyOpp}`);
  ok('with the same score', (await text('body')).includes(historyScore.trim()), historyScore);
  ok('and the minutes table', await evaluate("!!document.querySelector('.card .ln .nm2')"));

  await click('[data-act="closerecap"]');
  await sleep(300);
  ok('closing returns to history, not the match',
    await evaluate("!!document.querySelector('[data-act=\"tab:history\"]')"));

  await click('[data-act="tab:match"]');
  await sleep(250);
  ok('a live match is still resumable afterwards',
    await evaluate("!!document.querySelector('[data-act=\"resume\"]')"));

  ws.close();
}

main()
  .catch((e) => { failures++; console.log('  ✖ crashed:', e.message); })
  .finally(() => {
    cleanup();
    console.log(failures ? `\n${failures} failure(s)` : '\nall UI smoke checks passed');
    process.exit(failures ? 1 : 0);
  });
