// CF Pages Function — Sales Dashboard proxy
// GET /api/accurate?period=YYYY-MM
// Proxies to connector /api/analytics/sales-dashboard — no direct Accurate API calls.
// Eliminates "Too many subrequests" error (old version made 50+ paginated fetches per call).
// Secrets: CONNECTOR_URL, CONNECTOR_API_KEY

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

function getThisMonth() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const period = url.searchParams.get('period') || getThisMonth();
  const [year, month] = period.split('-').map(Number);

  if (!year || !month || isNaN(year) || isNaN(month)) {
    return new Response(JSON.stringify({ error: 'Invalid period. Expected YYYY-MM.' }), { status: 400, headers: CORS });
  }

  const connectorUrl = env.CONNECTOR_URL     || '';
  const apiKey       = env.CONNECTOR_API_KEY || '';

  if (!connectorUrl || !apiKey) {
    return new Response(JSON.stringify({ error: 'Connector not configured.' }), { status: 503, headers: CORS });
  }

  try {
    const r = await fetch(
      `${connectorUrl}/api/analytics/sales-dashboard?year=${year}&month=${month}`,
      { headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(30000) }
    );
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return new Response(JSON.stringify({ error: `Connector error HTTP ${r.status}: ${txt.slice(0, 200)}` }), { status: 502, headers: CORS });
    }
    const data = await r.json();
    return new Response(JSON.stringify(data), { headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
}
