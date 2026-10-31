// CF Pages Function — authenticated proxy to connector /api/doc-archive/*
// All methods: GET, POST, DELETE, OPTIONS
// CF env secrets: CONNECTOR_URL, CONNECTOR_API_KEY, DOC_ARCHIVE_JWT_SECRET
// JWT issued by /api/doc-archive-auth (12-hour lifespan)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

function fromB64url(s) {
  return atob(s.replace(/-/g,'+').replace(/_/g,'/').padEnd(s.length + (4 - s.length%4)%4, '='));
}

async function jwtVerify(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const [header, body, sigB64] = parts;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name:'HMAC', hash:'SHA-256' }, false, ['verify']
  );
  const sigBytes = Uint8Array.from(fromB64url(sigB64), c => c.charCodeAt(0));
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(`${header}.${body}`));
  if (!ok) throw new Error('invalid signature');
  const payload = JSON.parse(fromB64url(body));
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now()/1000)) throw new Error('expired');
  return payload;
}

async function handleRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return new Response(JSON.stringify({ error: 'Token diperlukan.' }), { status:401, headers:CORS });
  }

  const secret = env.DOC_ARCHIVE_JWT_SECRET || '';
  if (!secret) {
    return new Response(JSON.stringify({ error: 'DOC_ARCHIVE_JWT_SECRET belum dikonfigurasi.' }), { status:503, headers:CORS });
  }

  let jwtUser;
  try {
    const payload = await jwtVerify(token, secret);
    jwtUser = payload.sub;
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Token tidak valid atau sudah kedaluwarsa.' }), { status:401, headers:CORS });
  }
  if (!jwtUser) {
    return new Response(JSON.stringify({ error: 'Token tidak valid.' }), { status:401, headers:CORS });
  }

  const connUrl = env.CONNECTOR_URL || '';
  const connKey = env.CONNECTOR_API_KEY || '';
  if (!connUrl || !connKey) {
    return new Response(JSON.stringify({ error: 'Connector belum dikonfigurasi.' }), { status:503, headers:CORS });
  }

  // Build upstream URL: strip CF Pages origin, keep path + query
  const pathParts = params.path ? (Array.isArray(params.path) ? params.path : [params.path]) : [];
  const upstreamPath = pathParts.length ? pathParts.join('/') : '';
  const upstreamUrl = `${connUrl}/api/doc-archive${upstreamPath ? '/' + upstreamPath : ''}${url.search}`;

  // Forward request body (for POST/DELETE with body)
  const method = request.method;
  const contentType = request.headers.get('Content-Type') || '';

  let bodyInit;
  if (method !== 'GET' && method !== 'HEAD') {
    try { bodyInit = await request.arrayBuffer(); } catch (_) {}
  }

  const upstreamHeaders = {
    'X-Api-Key': connKey,
    'X-Doc-User': jwtUser,
  };
  if (contentType) upstreamHeaders['Content-Type'] = contentType;

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method,
      headers: upstreamHeaders,
      body: bodyInit && bodyInit.byteLength > 0 ? bodyInit : undefined,
      signal: AbortSignal.timeout(60000),
    });

    const resBody = await upstreamRes.arrayBuffer();
    const resHeaders = { ...CORS };
    const ct = upstreamRes.headers.get('Content-Type');
    if (ct) resHeaders['Content-Type'] = ct;

    return new Response(resBody, { status: upstreamRes.status, headers: resHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: `Connector error: ${e.message}` }), { status:502, headers:CORS });
  }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }
  return handleRequest(context);
}
