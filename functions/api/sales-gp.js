// CF Pages Function — Per-salesperson Revenue + Laba (GP) dari Accurate
// GET /api/sales-gp?year=2026&month=8
// Secrets required: ACCURATE_TOKEN_ADL, ACCURATE_TOKEN_GROUP,
//                   ACCURATE_APP_KEY, ACCURATE_SIG_SECRET,
//                   CONNECTOR_URL, CONNECTOR_API_KEY

const ACCURATE_BASE     = 'https://api.accurate.id/accurate/api';
const ACCURATE_BASE_ALT = 'https://iris.accurate.id/accurate/api';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

// Sales whitelist per branch (Santo's team only)
const WHITELIST = new Set([
  // Tangerang (TC)
  'APRIL','ULIN','RIA','FAJAR','ARYA','MONA','GUSTI','RIZAL','DEFA','SANDI',
  // Poins (PS)
  'DARTIK','TITI',
  // Mangga Dua (M2)
  'ADE','LILI',
]);

function toAccurateDate(yyyy, mm, dd) {
  return `${String(dd).padStart(2,'0')}/${String(mm).padStart(2,'0')}/${yyyy}`;
}

async function makeSignature(timestamp, sigSecret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(sigSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(timestamp)));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function makeHeaders(token, appKey, sigSecret) {
  const timestamp = Date.now();
  const signature = sigSecret ? await makeSignature(timestamp, sigSecret) : '';
  return {
    Authorization: `Bearer ${token}`,
    'X-Api-Key': appKey || '',
    'X-Api-Timestamp': String(timestamp),
    'X-Api-Signature': signature,
    Accept: 'application/json',
    'User-Agent': 'DZone-Dashboard/1.0',
  };
}

// Fetch all invoice pages for one entity
async function fetchEntityInvoices(token, appKey, sigSecret, startDate, endDate) {
  const all = [];
  const maxPages = 15; // cap at 1500 invoices per entity per month

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({
      fields: 'number,transDate,totalAmount,masterSalesmanName,detailItem',
      'filter.startDate': startDate,
      'filter.endDate': endDate,
      page: String(page),
      pageSize: '100',
    });

    const headers = await makeHeaders(token, appKey, sigSecret);

    let resp = await fetch(`${ACCURATE_BASE}/sales-invoice/list.do?${params}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok && resp.status >= 500) {
      resp = await fetch(`${ACCURATE_BASE_ALT}/sales-invoice/list.do?${params}`, {
        headers: await makeHeaders(token, appKey, sigSecret),
        signal: AbortSignal.timeout(10000),
      });
    }
    if (!resp.ok) throw new Error(`Accurate HTTP ${resp.status}`);

    const json = await resp.json();
    if (!json.s) break;
    const rows = json.d || [];
    if (!rows.length) break;
    all.push(...rows);
    const totalPages = json.sp?.pageCount || 1;
    if (page >= totalPages) break;
  }

  return all;
}

// Get modal (unit cost) map from connector: { itemKode -> modal }
async function fetchModalMap(connectorUrl, apiKey, dbId) {
  try {
    const r = await fetch(`${connectorUrl}/api/sheet/modal?db=${dbId}`, {
      headers: { 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return {};
    const data = await r.json();
    const map = {};
    for (const item of (data.items || [])) {
      if (item.kode && item.modal != null) map[item.kode] = parseFloat(item.modal) || 0;
    }
    return map;
  } catch {
    return {};
  }
}

// Aggregate invoices into per-salesperson revenue + laba
function aggregate(invoices, modalMap) {
  const byName = {};

  for (const inv of invoices) {
    const invSp = normalizeName(inv.masterSalesmanName || '');

    for (const item of (inv.detailItem || [])) {
      const sp = normalizeName(item.salesmanName || invSp || '');
      if (!sp) continue;

      const revenue = parseFloat(item.totalPrice) || (parseFloat(item.quantity) * parseFloat(item.unitPrice || 0));
      const qty     = parseFloat(item.quantity) || 0;
      const unitCost = parseFloat(item.unitCost) || 0;
      const kode    = item.item?.no || item.itemNo || '';

      // Laba: prefer Accurate-provided unitCost, fall back to modal map
      const cost = unitCost > 0 ? qty * unitCost : qty * (modalMap[kode] || 0);
      const laba = revenue - cost;

      if (!byName[sp]) byName[sp] = { name: sp, revenue: 0, cost: 0, laba: 0 };
      byName[sp].revenue += revenue;
      byName[sp].cost    += cost;
      byName[sp].laba    += laba;
    }

    // Fallback: if invoice has no detailItem, use totalAmount attributed to masterSalesmanName
    if (!(inv.detailItem || []).length && invSp) {
      const revenue = parseFloat(inv.totalAmount) || 0;
      if (!byName[invSp]) byName[invSp] = { name: invSp, revenue: 0, cost: 0, laba: 0 };
      byName[invSp].revenue += revenue;
    }
  }

  return Object.values(byName)
    .filter(s => WHITELIST.has(s.name))
    .map(s => ({
      name:    s.name,
      revenue: Math.round(s.revenue),
      cost:    Math.round(s.cost),
      laba:    Math.round(s.laba),
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

function normalizeName(raw) {
  if (!raw) return '';
  return raw.trim().toUpperCase().split(/[\s_]/)[0]; // first word, uppercase
}

function sum(list, field) {
  return list.reduce((s, r) => s + (r[field] || 0), 0);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const year  = parseInt(url.searchParams.get('year')  || new Date().getFullYear());
  const month = parseInt(url.searchParams.get('month') || (new Date().getMonth() + 1));

  if (!env.ACCURATE_TOKEN_ADL && !env.ACCURATE_TOKEN_GROUP) {
    return new Response(JSON.stringify({ available: false, reason: 'not_configured' }), { headers: CORS });
  }

  const lastDay  = new Date(year, month, 0).getDate();
  const startDate = toAccurateDate(year, month, 1);
  const endDate   = toAccurateDate(year, month, lastDay);

  const appKey    = env.ACCURATE_APP_KEY   || '';
  const sigSecret = env.ACCURATE_SIG_SECRET || '';
  const connUrl   = env.CONNECTOR_URL      || '';
  const connKey   = env.CONNECTOR_API_KEY  || '';

  // CF Cache check
  const cache    = caches.default;
  const cacheKey = new Request(`https://sales-gp-cache/${year}/${month}`);
  const cached   = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    // Fetch invoices + modal maps in parallel for PT and Group
    const [invAdl, invGroup, modalAdl, modalGroup] = await Promise.all([
      env.ACCURATE_TOKEN_ADL
        ? fetchEntityInvoices(env.ACCURATE_TOKEN_ADL, appKey, sigSecret, startDate, endDate)
        : Promise.resolve([]),
      env.ACCURATE_TOKEN_GROUP
        ? fetchEntityInvoices(env.ACCURATE_TOKEN_GROUP, appKey, sigSecret, startDate, endDate)
        : Promise.resolve([]),
      connUrl ? fetchModalMap(connUrl, connKey, 74419)  : Promise.resolve({}),
      connUrl ? fetchModalMap(connUrl, connKey, 131948) : Promise.resolve({}),
    ]);

    const pt    = aggregate(invAdl,   modalAdl);
    const group = aggregate(invGroup, modalGroup);

    // Combined: merge PT + Group per sales name
    const combinedMap = {};
    for (const s of [...pt, ...group]) {
      if (!combinedMap[s.name]) combinedMap[s.name] = { name: s.name, revenue: 0, laba: 0 };
      combinedMap[s.name].revenue += s.revenue;
      combinedMap[s.name].laba   += s.laba;
    }
    const combined = Object.values(combinedMap).sort((a, b) => b.revenue - a.revenue);

    const result = {
      available: true,
      year, month,
      pt:    { list: pt,    total_revenue: sum(pt, 'revenue'),    total_laba: sum(pt, 'laba') },
      group: { list: group, total_revenue: sum(group, 'revenue'), total_laba: sum(group, 'laba') },
      combined: { list: combined, total_revenue: sum(combined, 'revenue'), total_laba: sum(combined, 'laba') },
      has_cost_data: Object.keys(modalAdl).length > 0 || Object.keys(modalGroup).length > 0,
    };

    const resp = new Response(JSON.stringify(result), {
      headers: { ...CORS, 'Cache-Control': 's-maxage=3600' },
    });
    context.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;

  } catch (e) {
    return new Response(JSON.stringify({ available: false, reason: 'fetch_error', details: e.message }), {
      headers: CORS,
    });
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
