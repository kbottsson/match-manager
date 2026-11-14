/**
 * The club screen, end to end: inviting, being invited, and leaving.
 *
 * Boots a real `wrangler dev` with a real D1, then drives two headless phones:
 * an admin who invites, and a second coach who arrives through the link and
 * should see what they are joining before they spend the invite.
 *
 * Run: node tests/club.e2e.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { Phone, sleep } from './lib/phone.mjs';

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ✔ ${name}`);
  else { failures++; console.log(`  ✖ ${name}${extra ? ' — ' + extra : ''}`); }
};

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

rmSync('.wrangler/state', { recursive: true, force: true });
const schema = spawnSync('npx', ['--yes', 'wrangler@latest', 'd1', 'execute', 'match-manager',
  '--local', '--file', 'worker/schema.sql'], { encoding: 'utf8' });
if (schema.status !== 0) {
  console.error('schema apply failed:\n', (schema.stderr || '').slice(-1200));
  process.exit(1);
}

// Invite links are minted from APP_URL, so the test server must name itself —
// otherwise the link points at production and the test walks into the real club.
const dev = spawn('npx', ['--yes', 'wrangler@latest', 'dev', '--local', '--port', String(PORT), '--ip', '127.0.0.1',
  '--var', `APP_URL:${BASE}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let devLog = '';
dev.stdout.on('data', (d) => { devLog += d; });
dev.stderr.on('data', (d) => { devLog += d; });

let A = null;
let B = null;
function shutdown() {
  A?.close(); B?.close();
  try { dev.kill('SIGKILL'); } catch { /* ignore */ }
}
process.on('exit', shutdown);

try {
  let up = false;
  for (let i = 0; i < 200; i++) {
    try { const r = await api('GET', '/api/health'); if (r.status === 200 && r.body?.db) { up = true; break; } } catch { /* booting */ }
    await sleep(300);
  }
  if (!up) throw new Error('wrangler dev did not come up\n' + devLog.slice(-600));

  const boot = await api('POST', '/api/bootstrap', { body: { clubName: 'Uppåkra P16', ownerName: 'Derek' } });
  ok('a club exists', boot.status === 201, 'status ' + boot.status);
  const owner = boot.body.token;

  const adminInvite = await api('POST', '/api/members/invite', {
    token: owner, body: { role: 'team_admin', name: 'Derek' },
  });
  ok('an admin invite exists', adminInvite.status === 201);

  /* ---- a device token is accepted as itself, not mistaken for an invite ---- */
  D: {
    const owner = new Phone(9414, 'owner');
    try {
      await owner.launch();
      await owner.goto(BASE + '/join#' + boot.body.token);
      const screen = await owner.waitFor(async () => {
        const t = await owner.text();
        return /already has access|har redan åtkomst/i.test(t) ? t : null;
      }, 'the device-token screen');
      ok('a device token is recognised, not rejected as a bad invite', !!screen);
      ok('…and it says who this phone becomes', /Derek/.test(screen) && !/not valid|inte giltig/i.test(screen));
      ok('…without asking for a name', (await owner.js("!document.querySelector('input[name=name]')")) === true);

      await owner.click('[data-act="usedevicetoken"]');
      await owner.waitFor(() => owner.js("!!localStorage.getItem('mm.sync.pairing')"), 'the owner device pairs');
      ok('the owner token pairs the phone directly', true);
      const role = await owner.js("JSON.parse(localStorage.getItem('mm.sync.pairing')).member.role");
      ok('…as the owner, not a coach', role === 'owner', 'role ' + role);
    } finally { owner.close(); }
  }

  /* ---- the admin pairs and opens the club screen ---- */
  A = new Phone(9411, 'a');
  await A.launch();
  await A.goto(BASE + '/join#' + adminInvite.body.token);
  await A.waitFor(() => A.js("!!document.querySelector('input[name=name]')"), 'join form');
  await A.js("document.querySelector('input[name=name]').value = 'Derek'");
  await A.click('[data-act="dojoin"]');
  await A.waitFor(() => A.js("!!localStorage.getItem('mm.sync.pairing')"), 'A pairs');
  ok('the admin device is paired', true);

  await A.js("window.__errs = []; addEventListener('error', e => window.__errs.push(String(e.message))); true");
  await A.click('[data-act="club"]');
  await sleep(600);
  const clubScreen = await A.waitFor(async () => {
    const t = await A.text();
    return /tränare|coaches/i.test(t) ? t : null;
  }, 'club screen');
  ok('the club screen opens', !!clubScreen);
  ok('it names this device as signed in', /Derek/.test(clubScreen));

  /* ---- invite a coach from inside the app ---- */
  await A.click('[data-act="newinvite"]');
  const link = await A.waitFor(
    () => A.js("document.querySelector('[data-invite-link]')?.value || null"),
    'the invite link appears');
  ok('inviting a coach produces a link in the app', /\/join#/.test(link));

  const token = link.split('#')[1];
  const preview = await api('GET', `/api/invites/${token}/preview`);
  ok('the link leads to a real invite', preview.status === 200, 'status ' + preview.status);
  ok('…for the right club', preview.body?.club === boot.body.tenant.name, JSON.stringify(preview.body));

  /* ---- the invited coach sees the club before joining ---- */
  B = new Phone(9412, 'b');
  await B.launch();
  await B.goto(link);
  const joinText = await B.waitFor(async () => {
    const t = await B.text();
    return /player|spelare|Uppåkra/i.test(t) ? t : null;
  }, 'the join screen describes the club');
  ok('the join screen names the club before the invite is spent', /uppåkra p16/i.test(joinText));
  ok('…and says the club is empty, because nothing has been pushed yet', /starting|helt ny|0 players|0 spelare/i.test(joinText));

  await B.js("document.querySelector('input[name=name]').value = 'Amanda'");
  await B.click('[data-act="dojoin"]');
  await B.waitFor(() => B.js("!!localStorage.getItem('mm.sync.pairing')"), 'B pairs');
  ok('the second coach joins', true);

  /* ---- a plain coach gets no invite button, because the server would refuse ---- */
  await B.click('[data-act="club"]');
  await B.waitFor(() => B.js("!!document.querySelector('[data-act=\"refreshmembers\"]')"), 'B opens the club screen');
  await B.waitFor(() => B.js("!!document.querySelector('.row.plain')"), 'B sees the members list');
  ok('a coach may see the club', /amanda|derek/i.test(await B.text()));
  ok('…but is not offered an invite it could not use',
    (await B.js("!document.querySelector('[data-act=\"newinvite\"]')")) === true);
  await B.click('[data-act="home"]');
  ok('…and can leave the club screen', (await B.js("!document.querySelector('[data-act=\"refreshmembers\"]')")) === true);

  /* ---- adding another device to yourself ---- */
  D2: {
    const before = await api('GET', '/api/members', { token: owner });
    const membersBefore = (before.body?.members || []).filter((m) => !m.revokedAt).length;
    await A.click('[data-act="newdevicelink"]');
    const deviceLink = await A.waitFor(
      () => A.js("document.querySelector('[data-device-link]')?.value || null"), 'a device link appears');
    ok('a member can mint a link for their own second device', /\/join#/.test(deviceLink));

    const E = new Phone(9415, 'e');
    try {
      await E.launch();
      await E.goto(deviceLink);
      const screen = await E.waitFor(async () => {
        const t = await E.text();
        return /add this phone|addera den här telefonen|lägg till den här|device-link/i.test(t) ? t : null;
      }, 'the device-link screen');
      ok('the second device is told whose phone it becomes', /Derek/.test(screen));
      ok('…and is not asked for a name', (await E.js("!document.querySelector('input[name=name]')")) === true);

      await E.click('[data-act="adddevicelink"]');
      await E.waitFor(() => E.js("!!localStorage.getItem('mm.sync.pairing')"), 'the second device pairs');
      const pairing2 = await E.js("JSON.parse(localStorage.getItem('mm.sync.pairing'))");
      ok('it signs in as the same person', pairing2?.member?.role === 'team_admin', 'role ' + pairing2?.member?.role);

      const members = await api('GET', '/api/members', { token: owner });
      const live = (members.body?.members || []).filter((m) => !m.revokedAt);
      ok('…without creating a new membership', live.length === membersBefore,
        `${live.length} members, was ${membersBefore}`);
      const admin = live.find((m) => m.role === 'team_admin');
      ok('…and it is a second device on the same person', (admin?.devices || []).length === 2,
        `${(admin?.devices || []).length} devices`);
    } finally { E.close(); }
  }

  /* ---- a phone that joined outside a match still converges ---- */
  {
    const mode = await B.js('__mm.sync.state().mode');
    ok('a phone with no live match idles instead of stopping', mode === 'idle', 'mode ' + mode);
    ok('…and is still running', (await B.js('__mm.sync.state().running')) === true);

    // The club needs a team for a match to make sense to another phone.
    await api('PUT', '/api/docs/model', {
      token: owner,
      body: { body: {
        clubs: [{ id: 'c1', name: 'Uppåkra P16' }],
        seasons: [{ id: 's1', clubId: 'c1', year: 2026, closed: false }],
        people: [{ id: 'p1', name: 'Leo' }, { id: 'p2', name: 'Sam' }],
        entries: [{ personId: 'p1', seasonId: 's1', no: '4', status: 'active' },
                  { personId: 'p2', seasonId: 's1', no: '7', status: 'active' }],
        teams: [{ id: 't1', seasonId: 's1', name: 'P16 A', personIds: ['p1', 'p2'] }],
        clubId: 'c1', seasonId: 's1',
      } },
    });

    // Something happens on another device after this phone joined.
    await api('PUT', '/api/docs/match/m-late', {
      token: owner,
      body: { body: { id: 'm-late', opponent: 'Late Arrival FC', status: 'setup', teamId: 't1', seasonId: 's1' } },
    });
    const arrived = await B.waitFor(
      () => B.js("JSON.parse(localStorage.getItem('mm.v1.matches')||'[]').some(m => m.id === 'm-late')"),
      'the late match reaches the phone', 45000);
    ok('a match created later reaches the idle phone on its own', !!arrived);

    // …and it can be opened, with its plan drawn, on the phone that never saw it before.
    await B.js("document.querySelector('[data-act=\"tab:match\"]')?.click()");
    await B.waitFor(() => B.js("!!document.querySelector('[data-act^=\"openmatch:\"]')"),
      'the match appears in the list', 15000);
    ok('the match is listed, not an orphan', true);
    await B.click('[data-act^="openmatch:"]');
    await B.waitFor(() => B.js("document.querySelectorAll('.ptable td').length > 0"),
      'the plan screen draws', 15000);
    ok('the shared plan renders on the other phone',
      (await B.js("document.querySelectorAll('.ptable td').length")) > 0);

    /* ---- deleting a planned match must survive the next sync ---- */
    await B.click('[data-act="deletematch"]');
    await B.waitFor(() => B.js("!document.querySelector('[data-act^=\"openmatch:\\'m-late\\'\"]')"),
      'the match is gone from the list', 15000);
    ok('a planned match can be deleted', true);

    // This is the regression: a pull used to bring it straight back.
    await B.js('__mm.sync.now()');
    await sleep(1200);
    await B.js('__mm.sync.now()');
    await sleep(1200);
    const stillGone = await B.js(
      "!JSON.parse(localStorage.getItem('mm.v1.matches')||'[]').filter(m => !m.deletedAt).some(m => m.id === 'm-late')");
    ok('…and a sync does not resurrect it', stillGone);

    const doc = await api('GET', '/api/docs/match/m-late', { token: owner });
    ok('the deletion reaches the club as a tombstone', !!doc.body?.body?.deletedAt,
      JSON.stringify(doc.body?.body || {}).slice(0, 120));
  }

  /* ---- the admin sees them arrive ---- */
  if (!(await A.js("!!document.querySelector('[data-act=\"refreshmembers\"]')"))) {
    await A.click('[data-act="club"]');
    await A.waitFor(() => A.js("!!document.querySelector('[data-act=\"refreshmembers\"]')"), 'A back on the club screen');
  }
  await A.click('[data-act="refreshmembers"]');
  const both = await A.waitFor(async () => {
    const t = await A.text();
    return /Amanda/.test(t) ? t : null;
  }, 'the members list refreshes');
  ok('the admin sees the new coach in the club', /Amanda/.test(both));

  /* ---- revoking a link that was sent to the wrong person ---- */
  await A.click('[data-act="newinvite"]');
  const second = await A.waitFor(
    () => A.js("document.querySelector('[data-invite-link]')?.value || null"), 'a second link');
  await A.click('[data-act^="revokeinvite:"]');
  await A.waitFor(() => A.js("!document.querySelector('[data-invite-link]')"), 'the link is withdrawn');
  const dead = await api('GET', `/api/invites/${second.split('#')[1]}/preview`);
  ok('a revoked link stops working immediately', dead.status === 410, 'status ' + dead.status);

  C: {
    const C = new Phone(9413, 'c');
    try {
      await C.launch();
      await C.goto(second);
      const msg = await C.waitFor(async () => {
        const t = await C.text();
        return /does not work|fungerar inte/i.test(t) ? t : null;
      }, 'the revoked link is refused');
      ok('opening a revoked link says so, instead of failing silently', !!msg);
    } finally { C.close(); }
  }

  /* ---- leaving ---- */
  const before = await A.js("!!localStorage.getItem('mm.sync.pairing')");
  await A.click('[data-act="unpair"]');
  await A.waitFor(() => A.js("!localStorage.getItem('mm.sync.pairing')"), 'the device is unpaired');
  ok('a device can leave the club', before === true
    && (await A.js("!localStorage.getItem('mm.sync.pairing')")) === true);
  ok('…and asks first', A.dialogs.length > 0, 'dialogs: ' + A.dialogs.length);
  ok('…and says it is local only again', await A.js("!!document.querySelector('.chip.local')"));
} catch (err) {
  failures++;
  console.log('\n  ✖ ' + err.message);
} finally {
  shutdown();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall club checks passed');
process.exit(failures ? 1 : 0);
