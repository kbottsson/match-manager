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

  ws.close();
}

main()
  .catch((e) => { failures++; console.log('  ✖ crashed:', e.message); })
  .finally(() => {
    cleanup();
    console.log(failures ? `\n${failures} failure(s)` : '\nall UI smoke checks passed');
    process.exit(failures ? 1 : 0);
  });
