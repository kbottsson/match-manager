/**
 * API end-to-end test against a local `wrangler dev`.
 *
 * Boots a real Worker with a real (local) D1 database, then walks the whole
 * Phase 2 surface: bootstrap, invites, redemption, docs, events, sync, the lease,
 * team scoping, status monotonicity and revocation.
 *
 * Run: node tests/api.smoke.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ✔ ${name}`);
  else { failures++; console.log(`  ✖ ${name} ${extra}`); }
};

const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);

async function req(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body: json, headers: res.headers };
}

// Fresh local database every run, so assertions can be exact.
rmSync('.wrangler/state', { recursive: true, force: true });
const schema = spawnSync('npx', ['--yes', 'wrangler@latest', 'd1', 'execute', 'match-manager',
  '--local', '--file', 'worker/schema.sql'], { encoding: 'utf8' });
if (schema.status !== 0) {
  console.error('schema apply failed:\n', schema.stderr?.slice(-1200));
  process.exit(1);
}

const dev = spawn('npx', ['--yes', 'wrangler@latest', 'dev', '--local', '--port', String(PORT), '--ip', '127.0.0.1'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
let devLog = '';
dev.stdout.on('data', (d) => { devLog += d.toString(); });
dev.stderr.on('data', (d) => { devLog += d.toString(); });

function shutdown(code = 0) {
  try { dev.kill('SIGTERM'); } catch { /* already gone */ }
  process.exit(code);
}

async function waitForServer() {
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  return false;
}

async function main() {
  if (!await waitForServer()) {
    console.error('worker never came up:\n', devLog.slice(-2000));
    shutdown(1);
  }

  console.log('health');
  const health = await req('GET', '/api/health');
  eq('health is ok', health.body.ok, true);
  eq('db answers', health.body.db, true);

  console.log('bootstrap');
  const boot = await req('POST', '/api/bootstrap',
    { body: { clubName: 'Uppåkra P16', ownerName: 'Derek', deviceLabel: "Derek's iPhone" } });
  eq('bootstrap creates a tenant', boot.status, 201);
  const owner = boot.body.token;
  ok('owner token is returned once', typeof owner === 'string' && owner.length > 30);
  const again = await req('POST', '/api/bootstrap', { body: { clubName: 'X', ownerName: 'Y' } });
  eq('bootstrap is single-use', again.status, 409);

  console.log('identity');
  eq('no token means 401', (await req('GET', '/api/sync')).status, 401);
  const me = await req('GET', '/api/me', { token: owner });
  eq('owner role', me.body.member.role, 'owner');

  console.log('documents');
  const model = { v: 1, clubs: [{ id: 'c1', name: 'Uppåkra P16' }], teams: [{ id: 't1', name: 'P16 A' }, { id: 't2', name: 'P16 B' }] };
  const putModel = await req('PUT', '/api/docs/model/', { token: owner, body: { body: model } });
  eq('model written', putModel.status, 200);
  eq('first write is rev 1', putModel.body.rev, 1);

  const match = await req('PUT', '/api/docs/match/m1',
    { token: owner, body: { body: { id: 'm1', opponent: 'Lunds BK', status: 'setup', teamId: 't1' } } });
  eq('match written', match.body.rev, 1);

  const stale = await req('PUT', '/api/docs/match/m1',
    { token: owner, body: { body: { status: 'setup', teamId: 't1' } }, headers: { 'if-match': '99' } });
  eq('stale rev is refused', stale.status, 409);

  const regress = await req('PUT', '/api/docs/match/m1',
    { token: owner, body: { body: { status: 'setup', teamId: 't1' } } });
  eq('match can move forward', regress.status, 200);
  const toFinal = await req('PUT', '/api/docs/match/m1',
    { token: owner, body: { body: { status: 'final', teamId: 't1' } } });
  eq('final accepted', toFinal.status, 200);
  const backToSetup = await req('PUT', '/api/docs/match/m1',
    { token: owner, body: { body: { status: 'setup', teamId: 't1' } } });
  eq('status cannot go backwards', backToSetup.status, 409);

  console.log('events');
  const ev1 = { id: 'e1', matchId: 'm1', type: 'goal_for', atMs: 1000, clockMs: 60000, period: 1, payload: { scorer: 'p1' } };
  const ev2 = { id: 'e2', matchId: 'm1', type: 'sub', atMs: 1001, clockMs: 61000, period: 1, payload: { off: ['p1'], on: ['p2'] } };
  const post = await req('POST', '/api/events', { token: owner, body: { events: [ev1, ev2] } });
  eq('two events accepted', post.body.accepted, 2);
  const dupe = await req('POST', '/api/events', { token: owner, body: { events: [ev1, ev2] } });
  eq('re-posting is idempotent', dupe.body.duplicates, 2);
  eq('nothing extra written', dupe.body.accepted, 0);

  const ghost = await req('POST', '/api/events',
    { token: owner, body: { events: [{ ...ev1, id: 'e3', matchId: 'nope' }] } });
  eq('events for an unknown match are refused', ghost.status, 409);

  console.log('sync');
  const full = await req('GET', '/api/sync?since=0&revs=*', { token: owner });
  eq('sync returns both events', full.body.events.length, 2);
  eq('sync returns both docs (model + match)', full.body.docs.length, 2);
  ok('events carry a seq cursor', full.body.events.every((e) => typeof e.seq === 'number'));
  eq('server sets the author, not the client', full.body.events[0].author, me.body.member.id);

  const seqNow = full.body.seq;
  const revsMap = Object.fromEntries(full.body.docs.map((d) => [d.kind === 'model' ? 'model' : `${d.kind}:${d.id}`, d.rev]));
  const revsParam = Buffer.from(JSON.stringify(revsMap)).toString('base64url');
  const quiet = await req('GET', `/api/sync?since=${seqNow}&revs=${revsParam}`, { token: owner });
  ok('nothing new yields 304 or empty payload',
    quiet.status === 304 || (quiet.body.events.length === 0 && quiet.body.docs.length === 0),
    `status ${quiet.status}`);

  console.log('invites');
  const inv = await req('POST', '/api/members/invite',
    { token: owner, body: { role: 'team_admin', teamId: 't2', expiresInHours: 168 } });
  eq('invite created', inv.status, 201);
  ok('invite returns a link with the token in the fragment', inv.body.url.includes('/join#'));

  const redeem = await req('POST', '/api/auth/redeem', { body: { invite: inv.body.token, name: 'Amanda', device: "Amanda's iPhone" } });
  eq('invite redeems', redeem.status, 201);
  const amanda = redeem.body.token;
  eq('redeemed role', redeem.body.member.role, 'team_admin');

  const reuse = await req('POST', '/api/auth/redeem', { body: { invite: inv.body.token, name: 'Imposter' } });
  eq('an invite works once', reuse.status, 410);

  const meAmanda = await req('GET', '/api/me', { token: amanda });
  eq('team admin is scoped to their team', meAmanda.body.teams, ['t2']);

  console.log('team scoping');
  const wrongTeam = await req('PUT', '/api/docs/plan/m1', { token: amanda, body: { body: { v: 1, cells: [] } } });
  eq('cannot write another team\'s plan', wrongTeam.status, 403);

  await req('PUT', '/api/docs/match/m9', { token: owner, body: { body: { status: 'setup', teamId: 't2' } } });
  const rightTeam = await req('PUT', '/api/docs/plan/m9', { token: amanda, body: { body: { v: 1, cells: [] } } });
  eq('can write their own team\'s plan', rightTeam.status, 200);

  const wrongEvent = await req('POST', '/api/events',
    { token: amanda, body: { events: [{ id: 'x1', matchId: 'm1', type: 'goal_for', atMs: 1, payload: {} }] } });
  eq('cannot post events for another team', wrongEvent.status, 403);

  console.log('lease');
  const claim = await req('POST', '/api/matches/m9/lease', { token: amanda, body: { action: 'claim' } });
  eq('claim succeeds', claim.body.mine, true);

  const revocable = await req('POST', '/api/members/invite', { token: owner, body: { role: 'coach', name: 'Wrong person' } });
  eq('an invite can be created', revocable.status, 201);
  // The join screen must be able to describe the club before the invite is spent.
  const preview = await req('GET', `/api/invites/${revocable.body.token}/preview`);
  eq('an invite can be previewed without a token', preview.status, 200);
  eq('…and names the club it leads to', preview.body.club, boot.body.tenant.name);
  eq('…and how many players are already there', typeof preview.body.clubPlayers, 'number');
  eq('a made-up invite has no preview', (await req('GET', '/api/invites/nonsense/preview')).status, 410);

  const revokedInvite = await req('DELETE', `/api/invites/${revocable.body.id}`, { token: owner });
  eq('and revoked before it is used', revokedInvite.status, 200);
  const usedAfterRevoke = await req('POST', '/api/auth/redeem', { body: { invite: revocable.body.token, name: 'Wrong person' } });
  eq('a revoked invite cannot be redeemed', usedAfterRevoke.status, 410);
  eq('…and no longer previews either', (await req('GET', `/api/invites/${revocable.body.token}/preview`)).status, 410);

  const coachInvite = await req('POST', '/api/members/invite', { token: owner, body: { role: 'coach', teamId: 't2' } });
  const coachRedeem = await req('POST', '/api/auth/redeem', { body: { invite: coachInvite.body.token, name: 'Sam' } });
  const sam = coachRedeem.body.token;

  const blocked = await req('POST', '/api/matches/m9/lease', { token: sam, body: { action: 'claim' } });
  eq('a held lease blocks another coach', blocked.status, 409);
  eq('the holder is named', blocked.body.name, 'Amanda');

  const takeover = await req('POST', '/api/matches/m9/lease', { token: sam, body: { action: 'takeover' } });
  eq('takeover wins', takeover.body.mine, true);

  console.log('view links');
  const view = await req('POST', '/api/view-links', { token: owner, body: { teamId: 't2', expiresInDays: 30 } });
  const viewer = view.body.token;
  const viewSync = await req('GET', '/api/sync?since=0&revs=*', { token: viewer });
  eq('a view link can read', viewSync.status, 200);
  ok('a view link is scoped to its team',
    viewSync.body.docs.every((d) => d.kind === 'model' || d.id === 'm9'), JSON.stringify(viewSync.body.docs.map((d) => d.id)));
  const viewWrite = await req('POST', '/api/events', { token: viewer, body: { events: [ev1] } });
  eq('a view link cannot write', viewWrite.status, 403);

  console.log('revocation');
  const members = await req('GET', '/api/members', { token: owner });
  ok('members list includes devices', members.body.members.some((m) => m.devices.length > 0));
  const samRow = members.body.members.find((m) => m.name === 'Sam');
  const revoked = await req('DELETE', `/api/members/${samRow.id}`, { token: owner });
  eq('revoke succeeds', revoked.status, 200);
  eq('their token stops working', (await req('GET', '/api/me', { token: sam })).status, 401);
  eq('but the owner is unaffected', (await req('GET', '/api/me', { token: owner })).status, 200);

  console.log(failures ? `\n${failures} failure(s)` : '\nall API checks passed');
  shutdown(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('crashed:', err);
  console.error(devLog.slice(-1500));
  shutdown(1);
});
