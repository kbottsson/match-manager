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

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { stdio: 'ignore' });
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
  ok('clock shows seeded 07:12', (await text('[data-clock]')).includes('07:12'));
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

  ws.close();
}

main()
  .catch((e) => { failures++; console.log('  ✖ crashed:', e.message); })
  .finally(() => {
    cleanup();
    console.log(failures ? `\n${failures} failure(s)` : '\nall UI smoke checks passed');
    process.exit(failures ? 1 : 0);
  });
