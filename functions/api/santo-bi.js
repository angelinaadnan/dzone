// CF Pages Function — Santo BI (connector-backed)
// GET /api/santo-bi?year=YYYY&month=M
// Proxies to connector /api/analytics/santo — no direct Accurate API calls.
// Secrets: CONNECTOR_URL, CONNECTOR_API_KEY

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

// Maps new connector shape to include legacy fields expected by old cached index.html.
// Old _renderSanto() checks _bd.available and reads adl.pnl/.revenueTrend/.salesList/.branchList/.products.
// New _renderSanto() checks _bd.adl and reads adl.entity_summary/.revenue_trend/.sales_ranking etc.
// Both shapes coexist so either version of index.html renders correctly.
function legacyEntity(entity) {
  const s = entity.entity_summary || {};
  const mapProducts = (intel) => {
    const out = {};
    for (const [cat, items] of Object.entries(intel || {})) {
      out[cat] = (items || []).map(p => ({ code: p.item_no, name: p.item_name, qty: p.total_qty, revenue: p.line_revenue }));
    }
    return out;
  };
  return {
    ...entity,
    pnl: { revenue: s.revenue_gross ?? null, cogs: null, grossProfit: null, grossMargin: null, totalUnits: s.total_qty ?? null },
    revenueTrend: (entity.revenue_trend || []).map(t => ({ label: t.month, revenue: t.revenue_gross })),
    salesList:    (entity.sales_ranking  || []).map(s => ({ name: s.sales,  revenue: s.revenue_gross, qty: s.total_qty, branches: [] })),
    branchList:   (entity.branch_ranking || []).map(b => ({ name: b.branch, revenue: b.revenue_gross, qty: b.total_qty, sales: [] })),
    products: mapProducts(entity.product_intelligence),
    brands: {},
  };
}
function addLegacyFields(data) {
  if (!data || !data.adl) return data;
  return { ...data, available: true, adl: legacyEntity(data.adl), group: legacyEntity(data.group || {}) };
}

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
    return new Response(JSON.stringify(addLegacyFields(data)), { headers: CORS });
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
