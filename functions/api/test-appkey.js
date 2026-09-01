// Temporary debug endpoint — test App Key auth forwarding
// GET /api/test-appkey
// Remove after App Key auth is confirmed working

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export async function onRequestGet(context) {
  const { request, env } = context;

  const connUrl = env.CONNECTOR_URL     || '';
  const connKey = env.CONNECTOR_API_KEY || '';

  if (!connUrl) {
    return new Response(JSON.stringify({ error: 'CONNECTOR_URL not set' }), { headers: CORS });
  }

  const url = new URL(request.url);
  const qs = url.searchParams.toString();
  const resp = await fetch(`${connUrl}/api/sheet/test-appkey${qs ? '?' + qs : ''}`, {
    headers: {
      'X-API-Key':            connKey,
      'X-Accurate-App-Key':   env.ACCURATE_APP_KEY    || '',
      'X-Accurate-Sig-Sec':   env.ACCURATE_SIG_SECRET || '',
      'X-Accurate-Token-ADL': env.ACCURATE_TOKEN_ADL  || '',
    },
    signal: AbortSignal.timeout(15000),
  }).catch(e => null);

  if (!resp) return new Response(JSON.stringify({ error: 'connector unreachable' }), { headers: CORS });

  const data = await resp.json().catch(() => ({}));
  return new Response(JSON.stringify(data), { headers: CORS });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
  });
}
