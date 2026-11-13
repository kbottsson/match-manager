/**
 * Tokens and identity.
 *
 * A bearer token is either a device token (a person, with a role) or a view
 * link (anonymous, read-only). The tenant is derived from the token, so no club
 * identifier ever appears in a URL.
 */
import { sha256, nowIso } from './lib.js';

export async function authenticate(request, env) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(header.trim());
  if (!match) return null;

  const hash = await sha256(match[1]);

  const device = await env.DB.prepare(`
    SELECT d.id AS device_id, d.member_id, d.tenant, d.label,
           m.name, m.role, m.revoked_at AS member_revoked, d.revoked_at AS device_revoked
      FROM devices d
      JOIN members m ON m.id = d.member_id AND m.tenant = d.tenant
     WHERE d.token_hash = ?1
  `).bind(hash).first();

  if (device) {
    if (device.device_revoked || device.member_revoked) return null;
    return {
      kind: 'device',
      tenant: device.tenant,
      deviceId: device.device_id,
      memberId: device.member_id,
      name: device.name,
      role: device.role,
      tokenHash: hash,
    };
  }

  const view = await env.DB.prepare(`
    SELECT id, tenant, team_id, expires_at, revoked_at
      FROM view_links WHERE token_hash = ?1
  `).bind(hash).first();

  if (view && !view.revoked_at && view.expires_at > nowIso()) {
    return {
      kind: 'view',
      tenant: view.tenant,
      deviceId: null,
      memberId: null,
      name: 'Viewer',
      role: 'viewer',
      teamId: view.team_id || null,
      tokenHash: hash,
    };
  }

  return null;
}

/** Touch the device row so the members list can show "last seen". */
export async function touchDevice(env, auth) {
  if (auth.kind !== 'device') return;
  await env.DB.prepare('UPDATE devices SET last_seen = ?1 WHERE tenant = ?2 AND id = ?3')
    .bind(nowIso(), auth.tenant, auth.deviceId).run();
}

/** Which teams may this identity write to? Owner: everything. */
export async function memberTeams(env, auth) {
  if (auth.role === 'owner') {
    const rows = await env.DB.prepare('SELECT DISTINCT team_id FROM member_teams WHERE tenant = ?1')
      .bind(auth.tenant).all();
    return (rows.results || []).map((r) => r.team_id);
  }
  const rows = await env.DB.prepare('SELECT team_id FROM member_teams WHERE tenant = ?1 AND member_id = ?2')
    .bind(auth.tenant, auth.memberId).all();
  return (rows.results || []).map((r) => r.team_id);
}

/**
 * Team scoping narrows a coach's reach; it does not gate it. A coach invited
 * without a team is a club-wide coach — otherwise a coach invited before the
 * teams exist could write nothing at all.
 */
export async function canWriteTeam(env, auth, teamId) {
  if (auth.role === 'viewer') return false;
  if (auth.role === 'owner') return true;
  if (!teamId) return false;

  const scope = await env.DB.prepare(
    'SELECT team_id FROM member_teams WHERE tenant = ?1 AND member_id = ?2',
  ).bind(auth.tenant, auth.memberId).all();
  const teams = (scope.results || []).map((r) => r.team_id);
  if (!teams.length) return true;        // unscoped: the whole club
  return teams.includes(teamId);
}
