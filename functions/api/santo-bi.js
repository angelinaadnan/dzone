// CF Pages Function — Santo BI (connector-backed)
// GET /api/santo-bi?year=YYYY&month=M
// Proxies to connector /api/analytics/santo — no direct Accurate API calls.
// Secrets: CONNECTOR_URL, CONNECTOR_API_KEY

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

export async function onRequestGet(context) {
  const { request, env } = context;
  const url   = new URL(request.url);
  const year  = parseInt(url.searchParams.get('year')  || new Date().getFullYear(), 10);
  const month = parseInt(url.searchParams.get('month') || (new Date().getMonth() + 1), 10);

  const connectorUrl = env.CONNECTOR_URL      || '';
  const apiKey       = env.CONNECTOR_API_KEY  || '';

  if (!connectorUrl || !apiKey) {
    return new Response(JSON.stringify({ available: false, reason: 'not_configured' }), { headers: CORS });
  }

  try {
    const r = await fetch(
      `${connectorUrl}/api/analytics/santo?year=${year}&month=${month}`,
      { headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(30000) }
    );
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      return new Response(
        JSON.stringify({ available: false, reason: 'connector_error', details: `HTTP ${r.status}: ${errText.slice(0, 200)}` }),
        { headers: CORS }
      );
    }
    const data = await r.json();
    return new Response(JSON.stringify(data), { headers: CORS });
  } catch (e) {
    return new Response(
      JSON.stringify({ available: false, reason: 'error', details: e.message }),
      { headers: CORS }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
  });
}
