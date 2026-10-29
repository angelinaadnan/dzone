// CF Pages Function — authenticated proxy to connector /api/analytics/profit-dashboard
// Requires a valid JWT issued by /api/profit-auth (Liana, Angel, or Santo only).
// GET /api/profit-dashboard?year=2026&month=10
//   Header: Authorization: Bearer <jwt>
// Secrets (CF env): CONNECTOR_URL, CONNECTOR_API_KEY, PROFIT_JWT_SECRET

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const WHITELIST = ['Liana', 'Angel', 'Santo'];

// ── JWT verification (HS256, Web Crypto) ─────────────────────────────────────

function fromB64url(s) {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
}

async function jwtVerify(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const [header, body, sigB64] = parts;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const sigBytes = Uint8Array.from(fromB64url(sigB64), c => c.charCodeAt(0));
  const ok = await crypto.subtle.verify(
    'HMAC', key, sigBytes,
    new TextEncoder().encode(`${header}.${body}`)
  );
  if (!ok) throw new Error('invalid signature');
  const payload = JSON.parse(fromB64url(body));
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('expired');
  }
  return payload;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // ── 1. JWT auth ─────────────────────────────────────────────────────────────
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return new Response(JSON.stringify({ error: 'Unauthorized: token diperlukan.' }), { status: 401, headers: CORS });
  }

  const jwtSecret = env.PROFIT_JWT_SECRET || '';
  if (!jwtSecret) {
    return new Response(JSON.stringify({ error: 'Konfigurasi server belum lengkap.' }), { status: 503, headers: CORS });
  }

  let jwtUser;
  try {
    const payload = await jwtVerify(token, jwtSecret);
    jwtUser = payload.sub;
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'Token tidak valid atau sudah kedaluwarsa.' }),
      { status: 401, headers: CORS }
    );
  }

  if (!WHITELIST.includes(jwtUser)) {
    return new Response(JSON.stringify({ error: 'Akses ditolak.' }), { status: 403, headers: CORS });
  }

  // ── 2. Proxy ke connector ────────────────────────────────────────────────────
  const year  = parseInt(url.searchParams.get('year')  || new Date().getFullYear(), 10);
  const month = parseInt(url.searchParams.get('month') || (new Date().getMonth() + 1), 10);

  const connUrl = env.CONNECTOR_URL     || '';
  const connKey = env.CONNECTOR_API_KEY || '';

  if (!connUrl || !connKey) {
    return new Response(JSON.stringify({ error: 'Connector not configured.' }), { status: 503, headers: CORS });
  }

  try {
    const r = await fetch(
      `${connUrl}/api/analytics/profit-dashboard?year=${year}&month=${month}`,
      {
        headers: { 'X-Api-Key': connKey },
        signal: AbortSignal.timeout(30000),
      }
    );

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return new Response(
        JSON.stringify({ error: `Connector error HTTP ${r.status}: ${txt.slice(0, 200)}` }),
        { status: 502, headers: CORS }
      );
    }

    const data = await r.json();
    return new Response(JSON.stringify(data), { headers: CORS });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    },
  });
}
