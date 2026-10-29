// CF Pages Function — proxy profit sales matrix to connector (JWT-protected)
// GET /api/profit-sales-matrix?from=2026-05&to=2026-10

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const WHITELIST = ['Liana', 'Angel', 'Santo'];

function b64url(s) { return btoa(s).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'); }
function fromB64url(s) { return atob(s.replace(/-/g,'+').replace(/_/g,'/')); }

async function importHmacKey(secret, usage) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name:'HMAC', hash:'SHA-256' }, false, [usage]);
}

async function jwtVerify(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');
  const key = await importHmacKey(secret, 'verify');
  const msg = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sig = Uint8Array.from(fromB64url(parts[2]), c => c.charCodeAt(0));
  const ok  = await crypto.subtle.verify('HMAC', key, sig, msg);
  if (!ok) throw new Error('Invalid signature');
  const payload = JSON.parse(fromB64url(parts[1]));
  if (payload.exp && payload.exp < Math.floor(Date.now()/1000)) throw new Error('Token expired');
  return payload;
}

export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return new Response(JSON.stringify({ error: 'Token diperlukan.' }), { status:401, headers:CORS });

  const jwtSecret = env.PROFIT_JWT_SECRET || '';
  if (!jwtSecret) return new Response(JSON.stringify({ error: 'Server config error.' }), { status:503, headers:CORS });

  let payload;
  try { payload = await jwtVerify(token, jwtSecret); }
  catch(e) { return new Response(JSON.stringify({ error: 'Token tidak valid atau kadaluarsa.' }), { status:401, headers:CORS }); }

  if (!WHITELIST.includes(payload.sub))
    return new Response(JSON.stringify({ error: 'Akses ditolak.' }), { status:403, headers:CORS });

  const connUrl  = env.CONNECTOR_URL  || 'https://connectoracc.dzoutlet.co.id';
  const connKey  = env.CONNECTOR_API_KEY || '';
  if (!connKey) return new Response(JSON.stringify({ error: 'Connector key tidak tersedia.' }), { status:503, headers:CORS });

  const url = new URL(request.url);
  const from = url.searchParams.get('from') || '';
  const to   = url.searchParams.get('to')   || '';

  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to)   qs.set('to',   to);

  try {
    const resp = await fetch(`${connUrl}/api/analytics/profit-sales-matrix?${qs}`, {
      headers: { 'X-Api-Key': connKey },
    });
    const body = await resp.text();
    return new Response(body, { status: resp.status, headers: CORS });
  } catch(e) {
    return new Response(JSON.stringify({ error: 'Connector tidak dapat dihubungi.' }), { status:503, headers:CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }});
}
