// CF Pages Function — issue short-lived JWT for Profit Dashboard access
// POST /api/profit-auth  body: { user: "Liana", pin: "<dashboard-pin>" }
// Secrets (CF env): PROFIT_CREDS (JSON: {"Liana":"<pin>","Angel":"<pin>","Santo":"<pin>"})
//                   PROFIT_JWT_SECRET (random 64-char string)
// Returns: { token: "<jwt>" }  — expires in 8 hours
// Never exposes CONNECTOR_API_KEY or any other secret.

const CORS_POST = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const WHITELIST = ['Liana', 'Angel', 'Santo'];

// ── HS256 JWT helpers (Web Crypto — available in CF Workers) ──────────────────

function b64url(input) {
  return btoa(input).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function fromB64url(s) {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
}

async function importHmacKey(secret, usage) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage]
  );
}

async function jwtSign(payload, secret) {
  const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body    = b64url(JSON.stringify(payload));
  const message = `${header}.${body}`;
  const key     = await importHmacKey(secret, 'sign');
  const sigBuf  = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const sig     = b64url(String.fromCharCode(...new Uint8Array(sigBuf)));
  return `${message}.${sig}`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return new Response(JSON.stringify({ error: 'Body harus JSON.' }), { status: 400, headers: CORS_POST });
  }

  const { user, pin } = body || {};
  if (typeof user !== 'string' || typeof pin !== 'string' || !user || !pin) {
    return new Response(JSON.stringify({ error: 'Field user dan pin wajib diisi.' }), { status: 400, headers: CORS_POST });
  }

  if (!WHITELIST.includes(user)) {
    return new Response(JSON.stringify({ error: 'Akses ditolak.' }), { status: 403, headers: CORS_POST });
  }

  const credsRaw    = env.PROFIT_CREDS      || '';
  const jwtSecret   = env.PROFIT_JWT_SECRET || '';

  if (!credsRaw || !jwtSecret) {
    return new Response(JSON.stringify({ error: 'Konfigurasi server belum lengkap.' }), { status: 503, headers: CORS_POST });
  }

  let creds;
  try {
    creds = JSON.parse(credsRaw);
  } catch (_) {
    return new Response(JSON.stringify({ error: 'Konfigurasi server tidak valid.' }), { status: 503, headers: CORS_POST });
  }

  const expected = creds[user];
  if (typeof expected !== 'string' || pin !== expected) {
    return new Response(JSON.stringify({ error: 'PIN tidak valid.' }), { status: 401, headers: CORS_POST });
  }

  const now = Math.floor(Date.now() / 1000);
  const token = await jwtSign(
    { sub: user, iat: now, exp: now + 8 * 3600 },
    jwtSecret
  );

  return new Response(JSON.stringify({ token }), { headers: CORS_POST });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
