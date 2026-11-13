/**
 * Match Manager API.
 *
 * Documents (last-write-wins) + an append-only event log + one lease per match.
 * See docs/phase2-schema-and-api.md.
 *
 * CORS is stamped on every response in fetch(); handlers just return Responses.
 */
import {
  json, fail, newToken, sha256, nowIso, addHours, addDays,
  decodeB64Json, canWrite, RANK, clip,
} from './lib.js';
import { authenticate, memberTeams, canWriteTeam } from './auth.js';

const ALLOWED_ORIGINS = [
  'https://kbottsson.github.io',
  'https://kbottsson.com',
  'https://www.kbottsson.com',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-headers': 'authorization, content-type, if-match, if-none-match',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function withCors(response, cors) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

/* ------------------------------------------------------------------ *
 * reads shared by handlers
 * ------------------------------------------------------------------ */

const docRow = (env, tenant, kind, id) => env.DB
  .prepare('SELECT kind, id, body, rev, updated_at FROM docs WHERE tenant = ?1 AND kind = ?2 AND id = ?3')
  .bind(tenant, kind, id).first();

async function matchTeamId(env, tenant, matchId) {
  const row = await docRow(env, tenant, 'match', matchId);
  if (!row) return null;
  try { return JSON.parse(row.body).teamId || null; } catch { return null; }
}

const leaseRow = (env, tenant, matchId) => env.DB
  .prepare('SELECT match_id, holder, name, seen_at FROM lease WHERE tenant = ?1 AND match_id = ?2')
  .bind(tenant, matchId).first();

const LEASE_STALE_MS = 60_000;

/* ------------------------------------------------------------------ *
 * auth and membership
 * ------------------------------------------------------------------ */

async function bootstrap(request, env) {
  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM tenants').first();
  if ((existing?.n || 0) > 0) {
    return fail(409, 'already_bootstrapped', 'This instance already has a club. Use an invite.');
  }

  const data = await request.json().catch(() => ({}));
  const clubName = clip(String(data.clubName || '').trim(), 80);
  const ownerName = clip(String(data.ownerName || '').trim(), 60);
  const deviceLabel = clip(String(data.deviceLabel || '').trim(), 60) || 'Owner device';
  if (!clubName || !ownerName) return fail(400, 'invalid_input', 'clubName and ownerName are required.');

  const tenantId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const token = newToken();
  const at = nowIso();

  await env.DB.batch([
    env.DB.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?1, ?2, ?3)').bind(tenantId, clubName, at),
    env.DB.prepare('INSERT INTO members (tenant, id, name, role, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(tenantId, memberId, ownerName, 'owner', at),
    env.DB.prepare('INSERT INTO devices (tenant, id, member_id, token_hash, label, created_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)')
      .bind(tenantId, deviceId, memberId, await sha256(token), deviceLabel, at),
  ]);

  // The only moment a token is ever returned in clear. It is not recoverable.
  return json({
    tenant: { id: tenantId, name: clubName },
    member: { id: memberId, name: ownerName, role: 'owner' },
    token,
  }, 201);
}

async function redeem(request, env) {
  const data = await request.json().catch(() => ({}));
  const raw = String(data.invite || '');
  const name = clip(String(data.name || '').trim(), 60);
  const deviceLabel = clip(String(data.device || '').trim(), 60);
  if (!raw || !name) return fail(400, 'invalid_input', 'invite and name are required.');

  const invite = await env.DB.prepare(`
    SELECT id, tenant, role, team_id, expires_at, max_uses, uses, revoked_at
      FROM invites WHERE token_hash = ?1
  `).bind(await sha256(raw)).first();

  if (!invite) return fail(410, 'invite_invalid', 'This link is not valid.');
  if (invite.revoked_at) return fail(410, 'invite_revoked', 'This link has been revoked.');
  if (invite.expires_at <= nowIso()) return fail(410, 'invite_expired', 'This link has expired.');
  if (invite.uses >= invite.max_uses) return fail(410, 'invite_used', 'This link has already been used.');

  const tenant = await env.DB.prepare('SELECT id, name FROM tenants WHERE id = ?1').bind(invite.tenant).first();
  if (!tenant) return fail(410, 'tenant_missing', 'That club no longer exists.');

  const memberId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const token = newToken();
  const at = nowIso();

  const statements = [
    env.DB.prepare('INSERT INTO members (tenant, id, name, role, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(tenant.id, memberId, name, invite.role, at),
    env.DB.prepare('INSERT INTO devices (tenant, id, member_id, token_hash, label, created_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)')
      .bind(tenant.id, deviceId, memberId, await sha256(token), deviceLabel || `${name}'s phone`, at),
    env.DB.prepare('UPDATE invites SET uses = uses + 1 WHERE tenant = ?1 AND id = ?2').bind(tenant.id, invite.id),
  ];
  if (invite.team_id) {
    statements.push(env.DB.prepare('INSERT INTO member_teams (tenant, member_id, team_id) VALUES (?1, ?2, ?3)')
      .bind(tenant.id, memberId, invite.team_id));
  }
  await env.DB.batch(statements);

  return json({
    token,
    deviceId,
    tenant,
    member: { id: memberId, name, role: invite.role },
    teamId: invite.team_id || null,
  }, 201);
}

async function me(request, env, auth) {
  const tenant = await env.DB.prepare('SELECT id, name FROM tenants WHERE id = ?1').bind(auth.tenant).first();
  return json({
    tenant,
    deviceId: auth.deviceId,
    member: { id: auth.memberId, name: auth.name, role: auth.role },
    teams: await memberTeams(env, auth),
  });
}

async function listMembers(request, env, auth) {
  if (RANK[auth.role] < RANK.coach) return fail(403, 'forbidden', 'Not a member.');

  const rows = await env.DB.prepare(`
    SELECT m.id, m.name, m.role, m.created_at, m.revoked_at,
           (SELECT group_concat(team_id) FROM member_teams t
              WHERE t.tenant = m.tenant AND t.member_id = m.id) AS teams,
           (SELECT group_concat(label || '@' || COALESCE(last_seen, 'never'), '|')
              FROM devices d WHERE d.tenant = m.tenant AND d.member_id = m.id AND d.revoked_at IS NULL) AS devices
      FROM members m WHERE m.tenant = ?1 ORDER BY m.created_at
  `).bind(auth.tenant).all();

  const invites = await env.DB.prepare(`
    SELECT id, role, team_id, created_at, expires_at, max_uses, uses
      FROM invites WHERE tenant = ?1 AND revoked_at IS NULL AND expires_at > ?2 AND uses < max_uses
      ORDER BY created_at DESC
  `).bind(auth.tenant, nowIso()).all();

  return json({
    members: (rows.results || []).map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
      teams: r.teams ? r.teams.split(',') : [],
      devices: r.devices ? r.devices.split('|').map((d) => {
        const [label, lastSeen] = d.split('@');
        return { label, lastSeen };
      }) : [],
    })),
    invites: invites.results || [],
  });
}

async function createInvite(request, env, auth) {
  if (RANK[auth.role] < RANK.team_admin) return fail(403, 'forbidden', 'Only admins can invite.');

  const data = await request.json().catch(() => ({}));
  const role = String(data.role || 'coach');
  const teamId = data.teamId ? String(data.teamId) : null;
  const hours = Math.min(720, Math.max(1, Number(data.expiresInHours) || 168));

  if (!['coach', 'team_admin'].includes(role)) return fail(400, 'invalid_role', 'role must be coach or team_admin.');
  if (auth.role === 'team_admin') {
    if (role !== 'coach') return fail(403, 'forbidden', 'Team admins can only invite coaches.');
    // A team admin is normally scoped to their team and may only invite into
    // it. One with no team scope is a club admin in all but name, and may
    // invite coaches to the club — the same rule that lets them write anywhere.
    const scope = await memberTeams(env, auth);
    if (scope.length && (!teamId || !(await canWriteTeam(env, auth, teamId)))) {
      return fail(403, 'forbidden', 'Not your team.');
    }
  }

  const token = newToken();
  const id = crypto.randomUUID();
  const expiresAt = addHours(hours);

  await env.DB.prepare(`
    INSERT INTO invites (tenant, id, token_hash, role, team_id, created_by, created_at, expires_at, max_uses, uses)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, 0)
  `).bind(auth.tenant, id, await sha256(token), role, teamId, auth.memberId, nowIso(), expiresAt).run();

  return json({
    id, role, teamId, expiresAt,
    url: `${env.APP_URL || 'https://kbottsson.com'}/join#${token}`,
    token,
  }, 201);
}

/**
 * What a coach is about to walk into, before the invite is spent.
 *
 * Unauthenticated on purpose: the invite token is the credential, and the
 * person holding it can join anyway. It reveals the club name, the team and
 * how many players are already there — nothing about who they are.
 */
async function previewInvite(request, env, rawToken) {
  if (!rawToken) return fail(400, 'invalid_input', 'An invite token is required.');

  const invite = await env.DB.prepare(`
    SELECT id, tenant, role, team_id, expires_at, max_uses, uses, revoked_at
      FROM invites WHERE token_hash = ?1
  `).bind(await sha256(rawToken)).first();

  if (!invite) return fail(410, 'invite_invalid', 'This link is not valid.');
  if (invite.revoked_at) return fail(410, 'invite_revoked', 'This link has been revoked.');
  if (invite.expires_at <= nowIso()) return fail(410, 'invite_expired', 'This link has expired.');
  if (invite.uses >= invite.max_uses) return fail(410, 'invite_used', 'This link has already been used.');

  const tenant = await env.DB.prepare('SELECT id, name FROM tenants WHERE id = ?1').bind(invite.tenant).first();
  if (!tenant) return fail(410, 'tenant_missing', 'That club no longer exists.');

  let clubPlayers = 0;
  const model = await env.DB.prepare("SELECT body FROM docs WHERE tenant = ?1 AND kind = 'model'")
    .bind(invite.tenant).first();
  if (model) {
    try { clubPlayers = (JSON.parse(model.body).people || []).length; } catch { clubPlayers = 0; }
  }

  return json({
    club: tenant.name,
    role: invite.role,
    teamId: invite.team_id || null,
    clubPlayers,
  });
}

async function revokeMember(request, env, auth, memberId) {
  if (RANK[auth.role] < RANK.team_admin) return fail(403, 'forbidden', 'Only admins can revoke.');

  const target = await env.DB.prepare('SELECT id, role FROM members WHERE tenant = ?1 AND id = ?2')
    .bind(auth.tenant, memberId).first();
  if (!target) return fail(404, 'not_found', 'No such member.');
  if (target.role === 'owner' && auth.role !== 'owner') return fail(403, 'forbidden', 'Only an owner can revoke an owner.');

  if (auth.role === 'team_admin') {
    if (target.role !== 'coach') return fail(403, 'forbidden', 'Team admins can only revoke coaches.');
    const shared = await env.DB.prepare(`
      SELECT 1 AS ok FROM member_teams a
        JOIN member_teams b ON a.team_id = b.team_id AND a.tenant = b.tenant
       WHERE a.tenant = ?1 AND a.member_id = ?2 AND b.member_id = ?3
    `).bind(auth.tenant, auth.memberId, memberId).first();
    if (!shared) return fail(403, 'forbidden', 'Not yours to revoke.');
  }

  const at = nowIso();
  await env.DB.batch([
    env.DB.prepare('UPDATE members SET revoked_at = ?1 WHERE tenant = ?2 AND id = ?3').bind(at, auth.tenant, memberId),
    env.DB.prepare('UPDATE devices SET revoked_at = ?1 WHERE tenant = ?2 AND member_id = ?3').bind(at, auth.tenant, memberId),
  ]);
  return json({ ok: true, revokedAt: at });
}

async function createViewLink(request, env, auth) {
  if (RANK[auth.role] < RANK.team_admin) return fail(403, 'forbidden', 'Only admins can create links.');

  const data = await request.json().catch(() => ({}));
  const teamId = data.teamId ? String(data.teamId) : null;
  const days = Math.min(365, Math.max(1, Number(data.expiresInDays) || 90));
  if (teamId && auth.role === 'team_admin' && !(await canWriteTeam(env, auth, teamId))) {
    return fail(403, 'forbidden', 'Not your team.');
  }

  const token = newToken();
  const id = crypto.randomUUID();
  const expiresAt = addDays(days);
  await env.DB.prepare(`
    INSERT INTO view_links (tenant, id, token_hash, team_id, created_by, created_at, expires_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
  `).bind(auth.tenant, id, await sha256(token), teamId, auth.memberId, nowIso(), expiresAt).run();

  return json({ id, teamId, expiresAt, url: `${env.APP_URL || 'https://kbottsson.com'}/watch#${token}`, token }, 201);
}

/**
 * Revoking an invite matters more than it looks: an invite is a bearer token,
 * and the usual reason to revoke one is that it went to the wrong person.
 * Without this, the only remedy is waiting for it to expire.
 */
async function revokeInvite(request, env, auth, inviteId) {
  if (RANK[auth.role] < RANK.team_admin) return fail(403, 'forbidden', 'Only admins can revoke an invite.');

  const invite = await env.DB.prepare('SELECT id, role, team_id, revoked_at FROM invites WHERE tenant = ?1 AND id = ?2')
    .bind(auth.tenant, inviteId).first();
  if (!invite) return fail(404, 'not_found', 'No such invite.');
  if (invite.role === 'owner' && auth.role !== 'owner') return fail(403, 'forbidden', 'Only an owner can revoke an owner invite.');

  if (auth.role === 'team_admin') {
    if (invite.role !== 'coach') return fail(403, 'forbidden', 'Team admins can only revoke coach invites.');
    if (invite.team_id) {
      const shared = await env.DB.prepare(
        'SELECT 1 AS ok FROM member_teams WHERE tenant = ?1 AND member_id = ?2 AND team_id = ?3',
      ).bind(auth.tenant, auth.memberId, invite.team_id).first();
      if (!shared) return fail(403, 'forbidden', 'Not yours to revoke.');
    }
  }

  await env.DB.prepare('UPDATE invites SET revoked_at = ?1 WHERE tenant = ?2 AND id = ?3')
    .bind(nowIso(), auth.tenant, inviteId).run();
  return json({ id: inviteId, revoked: true });
}

async function revokeViewLink(request, env, auth, id) {
  if (RANK[auth.role] < RANK.team_admin) return fail(403, 'forbidden', 'Only admins can revoke links.');
  const row = await env.DB.prepare('SELECT id FROM view_links WHERE tenant = ?1 AND id = ?2')
    .bind(auth.tenant, id).first();
  if (!row) return fail(404, 'not_found', 'No such link.');
  await env.DB.prepare('UPDATE view_links SET revoked_at = ?1 WHERE tenant = ?2 AND id = ?3')
    .bind(nowIso(), auth.tenant, id).run();
  return json({ ok: true });
}

/* ------------------------------------------------------------------ *
 * sync
 * ------------------------------------------------------------------ */

async function postEvents(request, env, auth) {
  if (!canWrite(auth.role)) return fail(403, 'forbidden', 'Read-only access.');

  const data = await request.json().catch(() => ({}));
  const incoming = Array.isArray(data.events) ? data.events : [];
  if (!incoming.length) return fail(400, 'invalid_input', 'events[] is required.');
  if (incoming.length > 200) return fail(413, 'too_many', 'Send at most 200 events per request.');

  // The match must exist and be one this member may write.
  for (const matchId of [...new Set(incoming.map((e) => String(e.matchId || '')))]) {
    if (!matchId) return fail(400, 'invalid_input', 'Every event needs a matchId.');
    const teamId = await matchTeamId(env, auth.tenant, matchId);
    if (!teamId) return fail(409, 'unknown_match', `No match document for ${matchId}; push the doc first.`);
    if (!(await canWriteTeam(env, auth, teamId))) return fail(403, 'forbidden', `Not your team (${matchId}).`);
  }

  const rows = incoming.map((e) => ({
    id: clip(String(e.id || crypto.randomUUID()), 64),
    matchId: clip(String(e.matchId), 64),
    type: clip(String(e.type || ''), 40),
    atMs: Number(e.atMs) || Date.now(),
    clockMs: e.clockMs == null ? null : Number(e.clockMs),
    period: e.period == null ? null : Number(e.period),
    payload: JSON.stringify(e.payload ?? {}),
    voidOf: e.voidOf ? clip(String(e.voidOf), 64) : null,
  })).filter((r) => r.type);

  let accepted = 0;
  let duplicates = 0;
  for (const r of rows) {
    const res = await env.DB.prepare(`
      INSERT OR IGNORE INTO events
        (tenant, id, match_id, type, at_ms, clock_ms, period, payload, author, device, void_of, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
    `).bind(auth.tenant, r.id, r.matchId, r.type, r.atMs, r.clockMs, r.period, r.payload,
      auth.memberId, auth.deviceId, r.voidOf, nowIso()).run();
    if (res.meta?.changes) accepted += 1; else duplicates += 1;
  }

  const last = await env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE tenant = ?1')
    .bind(auth.tenant).first();
  return json({ seq: last?.seq || 0, accepted, duplicates });
}

async function sync(request, env, auth) {
  const url = new URL(request.url);
  const since = Math.max(0, Number(url.searchParams.get('since') || 0) || 0);
  const revParam = url.searchParams.get('revs');
  const revs = revParam === '*' ? '*' : (decodeB64Json(revParam) || {});

  // A team-scoped view link sees only that team's matches.
  let allowed = null;
  if (auth.kind === 'view' && auth.teamId) {
    const docs = await env.DB.prepare("SELECT id, body FROM docs WHERE tenant = ?1 AND kind = 'match'")
      .bind(auth.tenant).all();
    allowed = new Set((docs.results || []).filter((d) => {
      try { return JSON.parse(d.body).teamId === auth.teamId; } catch { return false; }
    }).map((d) => d.id));
  }

  const evRows = await env.DB.prepare(`
    SELECT seq, id, match_id, type, at_ms, clock_ms, period, payload, author, device, void_of
      FROM events WHERE tenant = ?1 AND seq > ?2 ORDER BY seq LIMIT 500
  `).bind(auth.tenant, since).all();

  const events = (evRows.results || [])
    .filter((e) => !allowed || allowed.has(e.match_id))
    .map((e) => ({
      seq: e.seq, id: e.id, matchId: e.match_id, type: e.type, atMs: e.at_ms,
      clockMs: e.clock_ms, period: e.period, payload: JSON.parse(e.payload),
      author: e.author, device: e.device, voidOf: e.void_of,
    }));

  const docRows = await env.DB.prepare('SELECT kind, id, rev, updated_at, body FROM docs WHERE tenant = ?1')
    .bind(auth.tenant).all();

  const docs = (docRows.results || []).filter((d) => {
    if (allowed && d.kind !== 'model' && !allowed.has(d.id)) return false;
    if (revs === '*') return true;
    const key = d.kind === 'model' ? 'model' : `${d.kind}:${d.id}`;
    return revs[key] === undefined || revs[key] !== d.rev;
  }).map((d) => ({ kind: d.kind, id: d.id, rev: d.rev, updatedAt: d.updated_at, body: JSON.parse(d.body) }));

  const leaseRows = await env.DB.prepare('SELECT match_id, holder, name, seen_at FROM lease WHERE tenant = ?1')
    .bind(auth.tenant).all();
  const leases = (leaseRows.results || [])
    .filter((l) => !allowed || allowed.has(l.match_id))
    .map((l) => ({ matchId: l.match_id, holder: l.holder, name: l.name, seenAt: l.seen_at }));

  const seq = events.length ? events[events.length - 1].seq : since;
  const stamp = [
    seq,
    docs.map((d) => `${d.kind}:${d.id}:${d.rev}`).join('|'),
    leases.map((l) => `${l.matchId}:${l.holder}:${l.seenAt}`).join('|'),
  ].join('~');
  const etag = `W/"${stamp.length}-${stamp.slice(-48).replace(/[^A-Za-z0-9:|-]/g, '')}"`;

  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  return json({ seq, events, docs, lease: leases }, 200, { etag });
}

async function putDoc(request, env, auth, kind, id) {
  if (!canWrite(auth.role)) return fail(403, 'forbidden', 'Read-only access.');
  if (!['model', 'match', 'plan'].includes(kind)) return fail(400, 'invalid_kind', 'Unknown document kind.');
  if (kind !== 'model' && !id) return fail(400, 'invalid_id', 'Document id is required.');

  const data = await request.json().catch(() => null);
  if (!data || typeof data !== 'object' || data.body === undefined) {
    return fail(400, 'invalid_input', 'Send { body: {...} }.');
  }

  const current = await docRow(env, auth.tenant, kind, id);
  const ifMatch = request.headers.get('if-match');

  if (current && ifMatch && ifMatch !== '*' && Number(ifMatch) !== current.rev) {
    return fail(409, 'rev_conflict', 'Someone wrote this document first.', {
      rev: current.rev, body: JSON.parse(current.body),
    });
  }

  if (kind === 'match' && current) {
    const order = { setup: 0, live: 1, final: 2 };
    let before = 0;
    let after = 0;
    try { before = order[JSON.parse(current.body).status] ?? 0; } catch { before = 0; }
    after = order[data.body.status] ?? before;
    if (after < before) {
      return fail(409, 'status_regression', 'A match cannot move backwards in status.', {
        rev: current.rev, body: JSON.parse(current.body),
      });
    }
  }

  if (kind === 'match' || kind === 'plan') {
    const teamId = kind === 'match' ? (data.body.teamId || null) : await matchTeamId(env, auth.tenant, id);
    if (kind === 'match' && !teamId) return fail(400, 'invalid_input', 'A match needs a teamId.');
    if (!(await canWriteTeam(env, auth, teamId))) return fail(403, 'forbidden', 'Not your team.');
  }

  const rev = (current?.rev || 0) + 1;
  const at = nowIso();
  await env.DB.prepare(`
    INSERT INTO docs (tenant, kind, id, body, rev, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT (tenant, kind, id) DO UPDATE SET body = ?4, rev = ?5, updated_at = ?6
  `).bind(auth.tenant, kind, id, JSON.stringify(data.body), rev, at).run();

  return json({ rev, updatedAt: at });
}

async function getDoc(request, env, auth, kind, id) {
  const row = await docRow(env, auth.tenant, kind, id);
  if (!row) return fail(404, 'not_found', 'No such document.');
  return json({ kind: row.kind, id: row.id, rev: row.rev, updatedAt: row.updated_at, body: JSON.parse(row.body) });
}

async function lease(request, env, auth, matchId) {
  if (!canWrite(auth.role)) return fail(403, 'forbidden', 'Read-only access.');

  const data = await request.json().catch(() => ({}));
  const action = String(data.action || 'heartbeat');

  const teamId = await matchTeamId(env, auth.tenant, matchId);
  if (!teamId) return fail(404, 'unknown_match', 'No match document for that id.');
  if (!(await canWriteTeam(env, auth, teamId))) return fail(403, 'forbidden', 'Not your team.');

  const current = await leaseRow(env, auth.tenant, matchId);
  const mine = !!current && current.holder === auth.deviceId;
  const fresh = !!current && Date.now() - Number(current.seen_at || 0) < LEASE_STALE_MS;

  if (action === 'release') {
    if (mine) {
      await env.DB.prepare('DELETE FROM lease WHERE tenant = ?1 AND match_id = ?2').bind(auth.tenant, matchId).run();
    }
    return json({ holder: null, name: null, seenAt: null, mine: false });
  }

  if (current && fresh && !mine && action !== 'takeover') {
    return fail(409, 'lease_held', 'Someone else is recording this match.', {
      holder: current.holder, name: current.name, seenAt: current.seen_at, mine: false,
    });
  }

  const at = Date.now();
  await env.DB.prepare(`
    INSERT INTO lease (tenant, match_id, holder, name, seen_at) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT (tenant, match_id) DO UPDATE SET holder = ?3, name = ?4, seen_at = ?5
  `).bind(auth.tenant, matchId, auth.deviceId, auth.name, at).run();

  return json({ holder: auth.deviceId, name: auth.name, seenAt: at, mine: true });
}

/* ------------------------------------------------------------------ *
 * router
 * ------------------------------------------------------------------ */

async function handle(request, env) {
  const url = new URL(request.url);

  if (url.hostname.startsWith('www.')) {
    return Response.redirect(`https://${url.hostname.slice(4)}${url.pathname}${url.search}`, 301);
  }

  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/api/health') {
    const started = Date.now();
    let ok = false;
    try { ok = (await env.DB.prepare('SELECT 1 AS ok').first())?.ok === 1; } catch { /* reported */ }
    return json({ ok, service: 'match-manager', db: ok, ms: Date.now() - started, time: nowIso() },
      ok ? 200 : 503);
  }

  if (path === '/api/bootstrap' && request.method === 'POST') return bootstrap(request, env);
  if (path === '/api/auth/redeem' && request.method === 'POST') return redeem(request, env);

  // Before the auth gate: the token in the path is the credential.
  let m = /^\/api\/invites\/([\w-]+)\/preview$/.exec(path);
  if (m && request.method === 'GET') return previewInvite(request, env, m[1]);

  if (!path.startsWith('/api/')) {
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return fail(404, 'not_found', 'No assets binding configured.');
  }

  const auth = await authenticate(request, env);
  if (!auth) return fail(401, 'unauthorized', 'Missing or invalid token.');

  if (path === '/api/me') return me(request, env, auth);
  if (path === '/api/members' && request.method === 'GET') return listMembers(request, env, auth);
  if (path === '/api/members/invite' && request.method === 'POST') return createInvite(request, env, auth);
  if (path === '/api/view-links' && request.method === 'POST') return createViewLink(request, env, auth);
  if (path === '/api/events' && request.method === 'POST') return postEvents(request, env, auth);
  if (path === '/api/sync' && request.method === 'GET') return sync(request, env, auth);

  m = /^\/api\/members\/([\w-]+)$/.exec(path);
  if (m && request.method === 'DELETE') return revokeMember(request, env, auth, m[1]);

  m = /^\/api\/invites\/([\w-]+)$/.exec(path);
  if (m && request.method === 'DELETE') return revokeInvite(request, env, auth, m[1]);

  m = /^\/api\/view-links\/([\w-]+)$/.exec(path);
  if (m && request.method === 'DELETE') return revokeViewLink(request, env, auth, m[1]);

  m = /^\/api\/docs\/([a-z]+)(?:\/([\w-]*))?$/.exec(path);
  if (m) {
    const kind = m[1];
    const id = decodeURIComponent(m[2] || '');
    if (request.method === 'PUT') return putDoc(request, env, auth, kind, id);
    if (request.method === 'GET') return getDoc(request, env, auth, kind, id);
  }

  m = /^\/api\/matches\/([\w-]+)\/lease$/.exec(path);
  if (m && request.method === 'POST') return lease(request, env, auth, m[1]);

  return fail(404, 'not_found', `No route for ${request.method} ${path}`);
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request.headers.get('origin') || '');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      return withCors(await handle(request, env), cors);
    } catch (err) {
      return withCors(fail(500, 'server_error', err?.message || 'Unexpected error'), cors);
    }
  },
};
