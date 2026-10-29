// CF Pages Function — thin proxy to connector /api/analytics/profit-dashboard
// Keeps CONNECTOR_API_KEY in Cloudflare env, never exposed to the browser.
// GET /api/profit-dashboard?year=2026&month=10
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
    },
  });
}
