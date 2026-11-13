/**
 * Small helpers shared by the Match Manager API.
 * No dependencies: WebCrypto + D1 only.
 */

export const json = (body, status = 200, headers = {}) => new Response(
  JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } },
);

export const fail = (status, code, message, extra = {}) => json(
  { error: code, message, ...extra },
  status,
);

/** 32 random bytes, base64url. Never stored — only its SHA-256 goes to D1. */
export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const nowIso = () => new Date().toISOString();
export const addHours = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
export const addDays = (d) => new Date(Date.now() + d * 86400 * 1000).toISOString();

/** Constant-time-ish compare for hex digests of equal length. */
export function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const RANK = { viewer: 0, coach: 1, team_admin: 2, owner: 3 };

export const canWrite = (role) => role === 'owner' || role === 'team_admin' || role === 'coach';

/** Base64url JSON in a query string. */
export function decodeB64Json(s) {
  if (!s) return null;
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function clip(s, n) {
  return typeof s === 'string' && s.length > n ? s.slice(0, n) : s;
}
