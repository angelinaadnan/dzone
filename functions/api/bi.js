// Cloudflare Pages Function — Business Intelligence API
// Serves KPI dashboards for 5 personas by combining Supabase + Accurate connector

const SB_URL = 'https://bikrfteylkbmjyrdsfnd.supabase.co';
// anon key is already public in index.html — safe to embed here
const SB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJpa3JmdGV5bGtibWp5cmRzZm5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NDAxNzEsImV4cCI6MjA5NTExNjE3MX0.BNxAQEA6P_pbgD3sRGcjNaMSY40_gYXBUkB9bqrHT5Y';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

// ── Supabase helper ───────────────────────────────────────────────────────────
// filters: { 'col.op': value } e.g. { 'date.gte': '2026-08-01', 'date.lte': '2026-08-31' }
// produces: ?date=gte.2026-08-01&date=lte.2026-08-31  (Supabase REST syntax)
// Using 'col.op' keys avoids the JS object duplicate-key problem.

async function sbQuery(table, filters = {}, select = '*', limit = 2000) {
  const url = new URL(`${SB_URL}/rest/v1/${table}`);
  url.searchParams.set('select', select);
  url.searchParams.set('limit', String(limit));
  for (const [key, val] of Object.entries(filters)) {
    const dotIdx = key.indexOf('.');
    if (dotIdx !== -1) {
      const col = key.slice(0, dotIdx);
      const op  = key.slice(dotIdx + 1);
      url.searchParams.append(col, `${op}.${val}`);
    } else {
      url.searchParams.append(key, String(val));
    }
  }
  const r = await fetch(url.toString(), {
    headers: { apikey: SB_ANON_KEY, Authorization: `Bearer ${SB_ANON_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase ${table}: HTTP ${r.status}`);
  return r.json();
}

// Calculate total value from goods/items jsonb array (handles string prices)
function calcGoodsValue(arr) {
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((s, g) => {
    const p = parseFloat(String(g.price || 0).replace(/,/g, '')) || 0;
    const q = parseFloat(String(g.qty || 1)) || 1;
    return s + p * q;
  }, 0);
}

function pctChange(cur, prev) {
  if (!prev) return null;
  return +((cur - prev) / prev * 100).toFixed(1);
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function monthRange(year, month) {
  const y = parseInt(year), m = parseInt(month);
  const from = `${y}-${String(m).padStart(2,'0')}-01`;
  const last = new Date(y, m, 0).getDate();
  const to   = `${y}-${String(m).padStart(2,'0')}-${String(last).padStart(2,'0')}`;
  return { from, to };
}

function priorMonthRange(year, month) {
  const m = parseInt(month), y = parseInt(year);
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  return monthRange(py, pm);
}

// ── Connector (Accurate PostgreSQL) proxy ─────────────────────────────────────

async function connectorDashboard(persona, year, month, connectorUrl, apiKey) {
  if (!connectorUrl || !apiKey) return null;
  const url = `${connectorUrl}/api/analytics/dashboard?persona=${encodeURIComponent(persona)}&year=${year}&month=${month}`;
  try {
    const r = await fetch(url, { headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

// ── Santo: Retail, Branch & People ───────────────────────────────────────────

async function santoKPIs(year, month, connectorUrl, apiKey) {
  const { from, to }           = monthRange(year, month);
  const { from: pFrom, to: pTo } = priorMonthRange(year, month);

  const [orders, ordersP, branchReqs, attendance] = await Promise.all([
    sbQuery('orders',
      { 'date.gte': from, 'date.lte': to },
      'date,sales_name,goods,status,payment_status,source_type,source_branch'),
    sbQuery('orders',
      { 'date.gte': pFrom, 'date.lte': pTo },
      'date,sales_name,goods,status'),
    sbQuery('branch_requests',
      { 'created_at.gte': `${from}T00:00:00`, 'created_at.lte': `${to}T23:59:59` },
      'status,branch_name,created_at,dispatched_at,delivered_at'),
    sbQuery('attendance',
      { 'check_in.gte': `${from}T00:00:00`, 'check_in.lte': `${to}T23:59:59` },
      'user_name,role,date,check_in,check_out'),
  ]);

  const activeOrders  = orders.filter(o => o.status !== 'cancelled');
  const activeOrdersP = ordersP.filter(o => o.status !== 'cancelled');
  const retail  = activeOrders.filter(o => o.source_type !== 'cabang');
  const retailP = activeOrdersP.filter(o => o.source_type !== 'cabang');
  const branchOrders = activeOrders.filter(o => o.source_type === 'cabang');

  const retailValue  = retail.reduce((s, o) => s + calcGoodsValue(o.goods), 0);
  const retailValueP = retailP.reduce((s, o) => s + calcGoodsValue(o.goods), 0);

  const attendees = new Set(attendance.map(a => a.user_name));
  const byDate = {};
  for (const a of attendance) {
    const d = a.date || (a.check_in ? a.check_in.slice(0, 10) : null);
    if (!d) continue;
    if (!byDate[d]) byDate[d] = new Set();
    byDate[d].add(a.user_name);
  }
  const dailyCounts = Object.entries(byDate)
    .sort(([a],[b]) => (a > b ? 1 : -1))
    .map(([date, s]) => ({ date, count: s.size }));

  const branchStatus = {};
  for (const r of branchReqs) branchStatus[r.status] = (branchStatus[r.status] || 0) + 1;

  const branchByLoc = {};
  for (const o of branchOrders) {
    const loc = (o.source_branch || 'Unknown').trim();
    if (!branchByLoc[loc]) branchByLoc[loc] = { count: 0, value: 0 };
    branchByLoc[loc].count++;
    branchByLoc[loc].value += calcGoodsValue(o.goods);
  }
  const branchByLocation = Object.entries(branchByLoc)
    .map(([location, d]) => ({ location, ...d }))
    .sort((a, b) => b.value - a.value);

  const orderStatus = {};
  for (const o of activeOrders) orderStatus[o.status] = (orderStatus[o.status] || 0) + 1;

  const bySales = {};
  for (const o of activeOrders) {
    const name = o.sales_name || 'Unknown';
    if (!bySales[name]) bySales[name] = { count: 0, value: 0 };
    bySales[name].count++;
    bySales[name].value += calcGoodsValue(o.goods);
  }
  const topSales = Object.entries(bySales)
    .map(([name, d]) => ({ name, ...d }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  const deliveredCount = activeOrders.filter(o => o.status === 'delivered' || o.status === 'ao_serah').length;
  const fulfillmentRate = activeOrders.length > 0
    ? +((deliveredCount / activeOrders.length) * 100).toFixed(1)
    : null;

  return {
    period: { from, to },
    retail: {
      order_count: retail.length,
      order_count_prior: retailP.length,
      order_count_mom: pctChange(retail.length, retailP.length),
      value: retailValue,
      value_prior: retailValueP,
      value_mom: pctChange(retailValue, retailValueP),
    },
    orders: { total: activeOrders.length, by_status: orderStatus },
    branch: { order_count: branchOrders.length, request_count: branchReqs.length, by_status: branchStatus, by_location: branchByLocation },
    people: {
      unique_attendance: attendees.size,
      total_checkins: attendance.length,
      daily_counts: dailyCounts.slice(-14),
    },
    sales_performance: topSales,
    fulfillment_rate: fulfillmentRate,
  };
}

// ── Angel: Corporate Sales & Growth ──────────────────────────────────────────

async function angelKPIs(year, month, connectorUrl, apiKey) {
  const { from, to }           = monthRange(year, month);
  const { from: pFrom, to: pTo } = priorMonthRange(year, month);

  const [quotations, quotationsP, accurate] = await Promise.all([
    sbQuery('quotations',
      { 'created_at.gte': `${from}T00:00:00`, 'created_at.lte': `${to}T23:59:59` },
      'status,type,sales_name,goods,customer_name,converted_at'),
    sbQuery('quotations',
      { 'created_at.gte': `${pFrom}T00:00:00`, 'created_at.lte': `${pTo}T23:59:59` },
      'status,sales_name,converted_at'),
    connectorDashboard('Angel', year, month, connectorUrl, apiKey),
  ]);

  const pipelineStatuses = ['draft', 'sent', 'approved'];
  const pipeline   = quotations.filter(q => pipelineStatuses.includes(q.status));
  const rejected   = quotations.filter(q => q.status === 'rejected');
  const converted  = quotations.filter(q => q.status === 'converted');
  const convertedP = quotationsP.filter(q => q.status === 'converted');

  const convRate  = quotations.length  ? +((converted.length  / quotations.length)  * 100).toFixed(1) : 0;
  const convRateP = quotationsP.length ? +((convertedP.length / quotationsP.length) * 100).toFixed(1) : 0;
  const pipelineValue = pipeline.reduce((s, q) => s + calcGoodsValue(q.goods), 0);

  const byStatus = {};
  for (const q of pipeline) byStatus[q.status] = (byStatus[q.status] || 0) + 1;

  const bySales = {};
  for (const q of quotations) {
    const name = q.sales_name || 'Unknown';
    if (!bySales[name]) bySales[name] = { total: 0, converted: 0, pipeline: 0 };
    bySales[name].total++;
    if (q.status === 'converted') bySales[name].converted++;
    if (pipelineStatuses.includes(q.status)) bySales[name].pipeline++;
  }
  const salesConversion = Object.entries(bySales)
    .map(([name, d]) => ({ name, ...d, rate: d.total ? +((d.converted/d.total)*100).toFixed(1) : 0 }))
    .sort((a, b) => b.converted - a.converted)
    .slice(0, 10);

  const accKPIs = accurate?.kpis;
  return {
    period: { from, to },
    pipeline: {
      total_count: pipeline.length,
      total_value: pipelineValue,
      converted_this_period: converted.length,
      converted_prior: convertedP.length,
      conversion_rate: convRate,
      conversion_rate_prior: convRateP,
      by_status: byStatus,
      rejected_count: rejected.length,
    },
    sales_conversion: salesConversion,
    b2b_revenue: accKPIs?.b2b || null,
    b2b_revenue_trend: accKPIs?.b2b_revenue_trend || [],
    customer_retention: accKPIs?.customer_retention || null,
    new_customers: accKPIs?.customers || null,
    top_customers: accKPIs?.top_customers?.slice(0, 10) || [],
  };
}

// ── Liana: Finance & Revenue ──────────────────────────────────────────────────

async function lianaKPIs(year, month, connectorUrl, apiKey) {
  const { from, to } = monthRange(year, month);

  const [orders, accurate] = await Promise.all([
    sbQuery('orders',
      { 'date.gte': from, 'date.lte': to },
      'payment_status,goods,status'),
    connectorDashboard('Liana', year, month, connectorUrl, apiKey),
  ]);

  const pmtBreakdown = {};
  for (const o of orders.filter(o => o.status !== 'cancelled')) {
    const p = o.payment_status || 'Unknown';
    if (!pmtBreakdown[p]) pmtBreakdown[p] = { count: 0, value: 0 };
    pmtBreakdown[p].count++;
    pmtBreakdown[p].value += calcGoodsValue(o.goods);
  }

  const acc = accurate?.kpis;
  const daysInPeriod = new Date(parseInt(year), parseInt(month), 0).getDate();
  const dso = (acc?.ar?.total && acc?.revenue?.total && acc.revenue.total > 0)
    ? +((acc.ar.total / (acc.revenue.total / daysInPeriod))).toFixed(1)
    : null;
  const arVal = acc?.ar?.total || 0;
  const arCnt = acc?.ar?.count || 0;
  let arStatus = 'green';
  if (arVal >= 500_000_000 || arCnt >= 10) arStatus = 'critical';
  else if (arVal >= 300_000_000 || arCnt >= 5) arStatus = 'warning';

  return {
    period: { from, to },
    accurate: acc || null,
    ytd: accurate?.ytd || null,
    collection_rate_trend: acc?.collection_rate_trend || [],
    yoy_revenue: acc?.yoy_revenue || null,
    internal_orders: {
      payment_breakdown: pmtBreakdown,
      total_orders: orders.filter(o => o.status !== 'cancelled').length,
    },
    dso,
    ar_alert: acc ? { status: arStatus, total: arVal, count: arCnt } : null,
  };
}

// ── Lukas: Product & Online ───────────────────────────────────────────────────

async function lukasKPIs(year, month, connectorUrl, apiKey) {
  const accurate = await connectorDashboard('Lukas', year, month, connectorUrl, apiKey);
  const kpis = accurate?.kpis || null;
  return {
    period: monthRange(year, month),
    accurate: kpis ? {
      channel_split:             kpis.channel_split             || null,
      stock:                     kpis.stock                     || null,
      top_items_by_revenue:      kpis.top_items_by_revenue      || [],
      top_items_by_qty:          kpis.top_items_by_qty          || [],
      slow_moving:               kpis.slow_moving               || [],
      marketplace_revenue_trend: kpis.marketplace_revenue_trend || [],
    } : null,
  };
}

// ── Jenny: Purchasing & Procurement ──────────────────────────────────────────

async function jennyKPIs(year, month, connectorUrl, apiKey) {
  const { from, to }           = monthRange(year, month);
  const { from: pFrom, to: pTo } = priorMonthRange(year, month);

  const [pos, posP, intakes, accurate] = await Promise.all([
    sbQuery('purchase_orders',
      { 'created_at.gte': `${from}T00:00:00`, 'created_at.lte': `${to}T23:59:59` },
      'status,supplier_name,items,ppn_type,created_at'),
    sbQuery('purchase_orders',
      { 'created_at.gte': `${pFrom}T00:00:00`, 'created_at.lte': `${pTo}T23:59:59` },
      'status,supplier_name,items'),
    sbQuery('service_intakes',
      { 'created_at.gte': `${from}T00:00:00`, 'created_at.lte': `${to}T23:59:59` },
      'status,unit_type,branch_name', 500),
    connectorDashboard('Jenny', year, month, connectorUrl, apiKey),
  ]);

  const activePOs  = pos.filter(p => p.status !== 'cancelled');
  const activePOsP = posP.filter(p => p.status !== 'cancelled');

  const poValue  = activePOs.reduce((s, po) => s + calcGoodsValue(po.items), 0);
  const poValueP = activePOsP.reduce((s, po) => s + calcGoodsValue(po.items), 0);

  const byStatus = {};
  for (const po of activePOs) byStatus[po.status] = (byStatus[po.status] || 0) + 1;

  const bySupplier = {};
  for (const po of activePOs) {
    const sup = (po.supplier_name || 'Unknown').trim();
    if (!bySupplier[sup]) bySupplier[sup] = { count: 0, value: 0 };
    bySupplier[sup].count++;
    bySupplier[sup].value += calcGoodsValue(po.items);
  }
  const topSuppliers = Object.entries(bySupplier)
    .map(([name, d]) => ({ name, ...d }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  const bySupplierP = {};
  for (const po of activePOsP) {
    const sup = (po.supplier_name || 'Unknown').trim();
    if (!bySupplierP[sup]) bySupplierP[sup] = { count: 0, value: 0 };
    bySupplierP[sup].count++;
    bySupplierP[sup].value += calcGoodsValue(po.items);
  }
  const topSuppliersP = Object.entries(bySupplierP)
    .map(([name, d]) => ({ name, ...d }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  const pending      = activePOs.filter(p => p.status !== 'completed');
  const pendingValue = pending.reduce((s, po) => s + calcGoodsValue(po.items), 0);

  const intakeStatus = {};
  for (const s of intakes) intakeStatus[s.status] = (intakeStatus[s.status] || 0) + 1;

  return {
    period: { from, to },
    purchasing: {
      po_count: activePOs.length,
      po_count_prior: activePOsP.length,
      po_count_mom: pctChange(activePOs.length, activePOsP.length),
      total_value: poValue,
      total_value_prior: poValueP,
      value_mom: pctChange(poValue, poValueP),
      by_status: byStatus,
      pending_count: pending.length,
      pending_value: pendingValue,
    },
    top_suppliers: topSuppliers,
    top_suppliers_prior: topSuppliersP,
    service_intakes: { total: intakes.length, by_status: intakeStatus },
    stock: accurate?.kpis?.stock || null,
    slow_moving: accurate?.kpis?.slow_moving || null,
    top_items_by_qty: accurate?.kpis?.top_items_by_qty || [],
    stock_coverage: accurate?.kpis?.stock_coverage || null,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const persona = url.searchParams.get('persona');
  const year    = parseInt(url.searchParams.get('year'))  || new Date().getFullYear();
  const month   = parseInt(url.searchParams.get('month')) || (new Date().getMonth() + 1);

  const ALLOWED = ['Santo', 'Angel', 'Liana', 'Lukas', 'Jenny'];
  if (!persona || !ALLOWED.includes(persona)) {
    return new Response(JSON.stringify({ error: 'persona required: Santo|Angel|Liana|Lukas|Jenny' }), {
      status: 400, headers: CORS,
    });
  }

  const connectorUrl = env.CONNECTOR_URL || '';
  const apiKey       = env.CONNECTOR_API_KEY || '';

  try {
    let data;
    switch (persona) {
      case 'Santo': {
        const gpUrl = new URL(`/api/sales-gp?year=${year}&month=${month}`, request.url).toString();
        const [santoData, gpResp] = await Promise.all([
          santoKPIs(year, month, connectorUrl, apiKey),
          fetch(gpUrl, { signal: AbortSignal.timeout(25000) }).catch(() => null),
        ]);
        data = santoData;
        if (gpResp?.ok) {
          const gpData = await gpResp.json().catch(() => null);
          if (gpData?.available) data.sales_gp = gpData;
        }
        break;
      }
      case 'Angel': data = await angelKPIs(year, month, connectorUrl, apiKey); break;
      case 'Liana': data = await lianaKPIs(year, month, connectorUrl, apiKey); break;
      case 'Lukas': data = await lukasKPIs(year, month, connectorUrl, apiKey); break;
      case 'Jenny': data = await jennyKPIs(year, month, connectorUrl, apiKey); break;
    }
    return new Response(
      JSON.stringify({ persona, year, month, data, generated_at: new Date().toISOString() }),
      { headers: CORS }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
  });
}
