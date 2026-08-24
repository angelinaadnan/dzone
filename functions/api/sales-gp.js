// CF Pages Function — thin proxy to connector /api/sheet/sales-gp
// All heavy Accurate API fetching happens in the connector (no CF subrequest limit there).
// GET /api/sales-gp?year=2026&month=8
// Secrets: CONNECTOR_URL, CONNECTOR_API_KEY

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const year  = parseInt(url.searchParams.get('year')  || new Date().getFullYear(), 10);
  const month = parseInt(url.searchParams.get('month') || (new Date().getMonth() + 1), 10);

  const connUrl = env.CONNECTOR_URL     || '';
  const connKey = env.CONNECTOR_API_KEY || '';

  if (!connUrl) {
    return new Response(JSON.stringify({ available: false, reason: 'not_configured' }), { headers: CORS });
  }

  // CF Cache check (1 hour)
  const cache    = caches.default;
  const cacheKey = new Request(`https://sales-gp-cache/${year}/${month}`);
  const cached   = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const connResp = await fetch(
      `${connUrl}/api/sheet/sales-gp?year=${year}&month=${month}`,
      {
        headers: { 'X-API-Key': connKey },
        signal:  AbortSignal.timeout(55000),
      }
    );

    if (!connResp.ok) {
      const body = await connResp.text().catch(() => '');
      return new Response(
        JSON.stringify({ available: false, reason: 'connector_error', details: `HTTP ${connResp.status}: ${body.slice(0, 200)}` }),
        { headers: CORS }
      );
    }

    const data = await connResp.json();

    const resp = new Response(JSON.stringify(data), {
      headers: { ...CORS, 'Cache-Control': 's-maxage=3600' },
    });
    if (data.available) context.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;

  } catch (e) {
    return new Response(
      JSON.stringify({ available: false, reason: 'fetch_error', details: e.message }),
      { headers: CORS }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    },
  });
}
