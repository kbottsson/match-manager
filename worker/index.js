/**
 * Match Manager API — Phase 2.
 *
 * Deliberately thin to start: this deploy exists to prove the spine (account,
 * domain, DNS, TLS, Worker, D1) end to end before any sync logic lands on top.
 */

const ALLOWED_ORIGINS = [
  'https://kbottsson.github.io',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
];

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-headers': 'authorization, content-type, if-match',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

const json = (body, status = 200, headers = {}) => new Response(
  JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } },
);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '';
    const headers = cors(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    if (url.pathname === '/api/health') {
      const started = Date.now();
      let db = false;
      try {
        const row = await env.DB.prepare('select 1 as ok').first();
        db = row?.ok === 1;
      } catch { /* reported below */ }
      return json({
        ok: db,
        service: 'match-manager',
        db,
        ms: Date.now() - started,
        time: new Date().toISOString(),
      }, db ? 200 : 503, headers);
    }

    return json({ error: 'not_found', path: url.pathname }, 404, headers);
  },
};
