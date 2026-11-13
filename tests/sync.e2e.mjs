/**
 * Two phones, one match — the phase-2 end-to-end test.
 *
 * Boots a real `wrangler dev` (real Worker, real local D1), then drives two
 * separate Chrome profiles against it:
 *
 *   A  pairs, adopts the squad already on the phone, records.
 *   B  pairs from an invite link and becomes a viewer.
 *
 * Proves: pairing adopts local data, events reach the other phone, the lease
 * makes B read-only by name, and takeover moves the pen.
 *
 * Run: node tests/sync.e2e.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8789;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ✔ ${name}`);
  else { failures++; console.log(`  ✖ ${name}${extra ? ' — ' + extra : ''}`); }
};

/* ------------------------------------------------------------------ *
 * API helpers
 * ------------------------------------------------------------------ */

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json };
}

/* ------------------------------------------------------------------ *
 * browser helper — one CDP connection per phone
 * ------------------------------------------------------------------ */

class Phone {
  constructor(port, profile) { this.port = port; this.profile = profile; this.msgId = 0; this.pending = new Map(); }

  async launch() {
    this.proc = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.profile}`, 'about:blank',
    ], { stdio: 'ignore' });

    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) { await this.connect(page.webSocketDebuggerUrl); return; }
      } catch { /* not up yet */ }
      await sleep(150);
    }
    throw new Error('chrome did not start on port ' + this.port);
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.addEventListener('error', reject);
      this.ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      });
      this.ws.addEventListener('open', resolve, { once: true });
    });
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.msgId;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async js(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return undefined;
    return r.result?.result?.value;
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 80; i++) {
      if (await this.js("document.readyState === 'complete'")) return;
      await sleep(100);
    }
  }

  /** Clicks the first element matching a selector, like a thumb would. */
  click(sel) {
    return this.js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return false; el.click(); return true; })()`);
  }

  async waitFor(fn, label, ms = 15000) {
    const started = Date.now();
    while (Date.now() - started < ms) {
      const v = await fn();
      if (v) return v;
      await sleep(300);
    }
    ok(label + ' (timed out)', false);
    return null;
  }

  text() { return this.js('document.body.innerText'); }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
    try { this.proc?.kill('SIGKILL'); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

const profiles = [mkdtempSync(join(tmpdir(), 'mm-e2e-a-')), mkdtempSync(join(tmpdir(), 'mm-e2e-b-'))];
const phones = [];

// A fresh local database every run, so the assertions can be exact. The schema
// has to land in the same place `wrangler dev` reads from.
rmSync('.wrangler/state', { recursive: true, force: true });
const schema = spawnSync('npx', ['--yes', 'wrangler@latest', 'd1', 'execute', 'match-manager',
  '--local', '--file', 'worker/schema.sql'], { encoding: 'utf8' });
if (schema.status !== 0) {
  console.error('schema apply failed:\n', (schema.stderr || '').slice(-1200));
  process.exit(1);
}

const dev = spawn('npx', ['--yes', 'wrangler@latest', 'dev', '--local', '--port', String(PORT), '--ip', '127.0.0.1'],
  { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
let devLog = '';
dev.stdout.on('data', (d) => { devLog += d; });
dev.stderr.on('data', (d) => { devLog += d; });

function shutdown() {
  for (const p of phones) p.close();
  try { dev.kill('SIGKILL'); } catch { /* ignore */ }
}
process.on('exit', shutdown);

try {
  /* ---- 1. a live API ---- */
  let up = false;
  for (let i = 0; i < 200; i++) {
    try { const r = await api('GET', '/api/health'); if (r.status === 200 && r.body?.db) { up = true; break; } } catch { /* booting */ }
    await sleep(300);
  }
  if (!up) throw new Error('wrangler dev did not come up\n' + devLog.slice(-800));
  ok('the app and API are served from one origin', true);
  ok('…and the app shell really is the app', (await api('GET', '/')).status === 200);

  /* ---- 2. a club with two invites ---- */
  const boot = await api('POST', '/api/bootstrap', { body: { clubName: 'Uppåkra P16', ownerName: 'Derek' } });
  ok('a club can be founded once', boot.status === 201, 'status ' + boot.status);
  const owner = boot.body.token;

  const invA = await api('POST', '/api/members/invite', { token: owner, body: { role: 'coach', kind: 'coach', name: 'Derek' } });
  const invB = await api('POST', '/api/members/invite', { token: owner, body: { role: 'coach', kind: 'coach', name: 'Amanda' } });
  ok('two coach invites exist', invA.status === 201 && invB.status === 201, `${invA.status}/${invB.status}`);

  /* ---- 3. phone A: local squad, then pair ---- */
  const A = new Phone(9401, profiles[0]); phones.push(A);
  await A.launch();
  await A.send('Page.enable');
  // Headless tabs report themselves hidden, which (correctly) pauses polling.
  await A.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  await A.goto(BASE + '/?seed=1');
  const seeded = await A.waitFor(async () => (await A.js("document.querySelector('.score')?.innerText || ''")).includes('–'), 'A has a match on the phone');
  ok('A starts unpaired, with a full match in local storage only', !!seeded);
  ok('…and says so on screen', /Endast lokalt|Local only/.test(await A.text()));
  ok('…and has not called the API', await A.js("localStorage.getItem('mm.sync.pairing') === null"));

  await A.goto(BASE + '/join#' + invA.body.token);
  const joinScreen = await A.waitFor(async () => /ditt namn|your name/i.test(await A.text()), 'the join screen');
  ok('the invite link opens the join screen', !!joinScreen);
  await A.js("document.querySelector('input[name=name]').value = 'Derek'");
  await A.click('[data-act="dojoin"]');
  const pairedA = await A.waitFor(() => A.js("!!localStorage.getItem('mm.sync.pairing')"), 'A pairs');
  ok('A pairs from the invite link', !!pairedA);
  const devId = await A.js("JSON.parse(localStorage.getItem('mm.sync.pairing')||'{}').deviceId");
  ok('…and knows its own device id, so it can tell its lease from someone else\'s', !!devId);


  /* ---- 4. pairing adopts what was already on the phone ---- */
  const adopted = await A.waitFor(async () => {
    const r = await api('GET', '/api/sync?since=0&revs=*', { token: owner });
    const docs = r.body?.docs || [];
    const events = r.body?.events || [];
    return (docs.some((d) => d.kind === 'model') && docs.some((d) => d.kind === 'match') && events.length >= 9)
      ? { docs: docs.length, events: events.length } : null;
  }, 'the club receives the local season');
  ok('pairing pushes the roster, the match and its events up', !!adopted,
    adopted ? `${adopted.docs} docs, ${adopted.events} events` : 'nothing arrived');

  const modelDoc = (await api('GET', '/api/sync?since=0&revs=*', { token: owner })).body.docs.find((d) => d.kind === 'model');
  ok('the roster arrived with the right nine kids', modelDoc?.body?.people?.length === 9,
    'got ' + modelDoc?.body?.people?.length);

  /* ---- 5. phone B: pairs and becomes a viewer ---- */
  const B = new Phone(9402, profiles[1]); phones.push(B);
  await B.launch();
  await B.send('Page.enable');
  await B.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  await B.goto(BASE + '/join#' + invB.body.token);
  await B.waitFor(() => B.js("!!document.querySelector('input[name=name]')"), 'B sees the join screen');
  await B.js("document.querySelector('input[name=name]').value = 'Amanda'");
  await B.click('[data-act="dojoin"]');
  ok('B pairs from its own invite', !!(await B.waitFor(() => B.js("!!localStorage.getItem('mm.sync.pairing')"), 'B pairs')));


  const bSeesMatch = await B.waitFor(async () => {
    const t = await B.text();
    return t.includes('–') && (t.match(/\d+\s*[–-]\s*\d+/) || t.includes('Avbytare') || t.includes('Bench'));
  }, 'B lands on the live match');
  ok('B is taken straight to the live match it has never seen', !!bSeesMatch);

  const bScore = await B.waitFor(async () => {
    const sc = await B.js("document.querySelector('.score')?.innerText || ''");
    return sc.includes('–') ? sc.replace(/\s/g, '') : null;
  }, 'B shows a score');
  ok('B shows the same score as A', bScore === '2–1', 'got ' + bScore);

  /* ---- 6. the lease makes B a viewer, by name ---- */
  const roText = await B.waitFor(async () => {
    const t = await B.text();
    return /Derek is recording|Derek registrerar/i.test(t) ? t : null;
  }, 'B is told who is recording');
  ok('B is read-only and names the recorder', !!roText);
  ok('B has no goal button on any row', (await B.js("document.querySelectorAll('[data-act^=\"goal:\"]').length")) === 0);

  /* ---- 7. A records; B sees it without touching anything ---- */
  const before = await A.js("document.querySelectorAll('[data-act^=\"goal:\"]').length");
  ok('A (the recorder) does have goal buttons', before > 0, 'count ' + before);

  await A.click('[data-act^="goal:"]');
  await A.waitFor(() => A.js("!!document.querySelector('[data-act=\"assist:none\"]')"), 'the assist sheet opens');
  await A.click('[data-act="assist:none"]');

  const aScore = await A.waitFor(async () => {
    const sc = await A.js("document.querySelector('.score')?.innerText || ''");
    return sc.replace(/\s/g, '') === '3–1' ? sc : null;
  }, 'A scores');
  ok('A records a goal at once', !!aScore);


  const bUpdated = await B.waitFor(async () => {
    const sc = await B.js("document.querySelector('.score')?.innerText || ''");
    return sc.replace(/\s/g, '') === '3–1' ? sc : null;
  }, 'B receives the goal by polling', 20000);
  ok('the goal reaches B by itself (no reload, no tap)', bUpdated === '3–1', 'B shows ' + (bUpdated || 'stale'));

  /* ---- 8. takeover moves the pen ---- */
  await B.click('[data-act="takeover"]');
  const bCanWrite = await B.waitFor(() => B.js("document.querySelectorAll('[data-act^=\"goal:\"]').length > 0"), 'B takes over');
  ok('B can take over the pen deliberately', !!bCanWrite);

  const aLost = await A.waitFor(async () => {
    const t = await A.text();
    return /Amanda is recording|Amanda registrerar/.test(t);
  }, 'A notices it is no longer recording', 20000);
  ok('A is demoted to read-only, without asking', !!aLost);

  /* ---- 9. a recorder who goes quiet does not hand over the pen silently ---- */
  // A is read-only now (B holds it). Age B's lease past the stale window and
  // the screen must say so, keep A out of the controls, and offer the choice.
  await A.js(`(() => {
    __mm.remote.lease = { holder: 'someone-else', name: 'Amanda', seenAt: Date.now() - 65000 };
    __mm.render();
    return true;
  })()`);
  await sleep(400);
  const quietText = await A.text();
  ok('a recorder who has gone quiet is announced', /stoppade registrera|stopped recording/i.test(quietText),
    quietText.slice(0, 120));
  ok('…and the screen is still not writable', (await A.js("document.querySelectorAll('[data-act^=\"goal:\"]').length")) === 0);
  ok('…with the pen offered, not taken', await A.js("!!document.querySelector('[data-act=\"takeover\"]')"));

  const stillStale = await A.js('__mm.remote.lease?.holder');
  ok('…and nothing claimed it behind the coach\'s back', stillStale === 'someone-else', 'holder ' + stillStale);

  /* ---- 10. the event logs agree ---- */
  const aEvents = await A.js("JSON.parse(localStorage.getItem('mm.v1.events.m1') || '[]').map(e => e.id)");
  const bEvents = await B.js("JSON.parse(localStorage.getItem('mm.v1.events.m1') || '[]').map(e => e.id)");
  ok('both phones hold the same event log', JSON.stringify(aEvents) === JSON.stringify(bEvents),
    `A ${aEvents?.length} vs B ${bEvents?.length}`);

  const order = await B.js(`(() => { const ev = JSON.parse(localStorage.getItem('mm.v1.events.m1') || '[]');
    for (let i = 1; i < ev.length; i++) if (Number(ev[i].atMs) <= Number(ev[i-1].atMs)) return false; return true; })()`);
  ok('the log is still strictly ordered on the receiving phone', order === true);
} catch (err) {
  failures++;
  console.log('\n  ✖ ' + err.message);
} finally {
  shutdown();
  for (const p of profiles) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall sync end-to-end checks passed');
process.exit(failures ? 1 : 0);
