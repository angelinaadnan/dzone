// Cloudflare Pages Function — proxy ke Accurate Online API
// Secrets (Cloudflare Dashboard → Settings → Environment Variables):
//   ACCURATE_TOKEN_ADL   = API token DB PT ANUGERAH DIGITAL LESTARI (PPN)
//   ACCURATE_TOKEN_GROUP = API token DB GROUP (non-PPN)
//   ACCURATE_APP_KEY     = App Key dari Accurate Developer Portal
//   ACCURATE_SIG_SECRET  = Signature Secret dari Accurate Developer Portal

const ACCURATE_BASE = 'https://api.accurate.id/accurate/api';
const ACCURATE_BASE_ALT = 'https://iris.accurate.id/accurate/api';

const BRANCH_LABELS = { TC: 'Tangerang', PS: 'Poins', M2: 'Mangga Dua' };
const WAREHOUSE_BRANCHES = {
  Tangerang:  ['TC DZ', 'TC NMC', 'TC HOI'],
  Poins:      ['PS NMC'],
  'Mangga Dua': ['M2 DZ', 'M2 BIG', 'M2 ADL'],
};

function getBranchLabel(branchName) {
  if (!branchName) return 'Lainnya';
  const prefix = branchName.trim().split(/[\s-]+/)[0].toUpperCase();
  return BRANCH_LABELS[prefix] || branchName;
}

function normalizeWarehouse(name) {
  if (!name) return '';
  return name.replace(/\s*-\s*/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}

// Generate X-Api-Signature: Base64(HMAC-SHA256(timestamp_ms, signature_secret))
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

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const period = url.searchParams.get('period') || getThisMonth();
  const debugMode = url.searchParams.get('debug') === '1';

  try {
    const [year, month] = period.split('-').map(Number);
    const lastDay = new Date(year, month, 0).getDate();
    // Use yyyy-MM-dd format for date filters
    const startDate = `${year}-${String(month).padStart(2,'0')}-01`;
    const endDate = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

    const appKey = env.ACCURATE_APP_KEY || '';
    const sigSecret = env.ACCURATE_SIG_SECRET || '';

    const [invAdl, invGroup] = await Promise.all([
      env.ACCURATE_TOKEN_ADL
        ? fetchAllInvoices(env.ACCURATE_TOKEN_ADL, appKey, sigSecret, startDate, endDate)
        : Promise.resolve({ data: [], rawFirst: null }),
      env.ACCURATE_TOKEN_GROUP
        ? fetchAllInvoices(env.ACCURATE_TOKEN_GROUP, appKey, sigSecret, startDate, endDate)
        : Promise.resolve({ data: [], rawFirst: null }),
    ]);

    const allInvoices = [...invAdl.data, ...invGroup.data];

    if (debugMode) {
      return new Response(JSON.stringify({
        totalInvoices: allInvoices.length,
        startDate, endDate,
        paginationADL: invAdl.rawFirst?.sp,
        paginationGROUP: invGroup.rawFirst?.sp,
        firstInvoice: allInvoices[0] || null,
        firstItem: allInvoices[0]?.detailItem?.[0] || null,
        sampleKeys: allInvoices[0] ? Object.keys(allInvoices[0]) : [],
      }), { headers: corsHeaders });
    }

    const result = aggregateData(allInvoices, period);
    return new Response(JSON.stringify(result), { headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    },
  });
}

// ─── Fetch all invoice pages ──────────────────────────────────────────────────
async function fetchAllInvoices(token, appKey, sigSecret, startDate, endDate) {
  const all = [];
  let rawFirst = null;
  let page = 1;
  const pageSize = 100;

  while (true) {
    const params = new URLSearchParams({
      // Correct field names confirmed from invoice detail endpoint
      fields: 'number,transDate,totalAmount,branchName,masterSalesmanName,customer,detailItem',
      'filter.startDate': startDate,
      'filter.endDate': endDate,
      page: String(page),
      pageSize: String(pageSize),
    });

    const timestamp = Date.now();
    const signature = sigSecret ? await makeSignature(timestamp, sigSecret) : '';

    const headers = {
      Authorization: `Bearer ${token}`,
      'X-Api-Key': appKey,
      'X-Api-Timestamp': String(timestamp),
      'X-Api-Signature': signature,
      Accept: 'application/json',
      'User-Agent': 'DZone-Dashboard/1.0',
    };

    let resp = await fetch(`${ACCURATE_BASE}/sales-invoice/list.do?${params}`, { headers });
    if (!resp.ok && resp.status >= 500) {
      resp = await fetch(`${ACCURATE_BASE_ALT}/sales-invoice/list.do?${params}`, { headers });
    }

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Accurate API ${resp.status}: ${txt.slice(0, 300)}`);
    }

    const json = await resp.json();
    if (page === 1) rawFirst = json;

    const rows = json.d || json.data || [];
    if (!json.s || rows.length === 0) break;

    all.push(...rows);
    // Stop when last page or safety limit
    const totalRows = json.sp?.rowCount || json.total || Infinity;
    if (rows.length < pageSize || all.length >= totalRows) break;
    page++;
    if (page > 50) break;
  }

  return { data: all, rawFirst };
}

// ─── Aggregate data ───────────────────────────────────────────────────────────
function aggregateData(invoices, period) {
  const overall = makeAcc();
  const byBranch = {};
  const byStore = {};

  for (const inv of invoices) {
    const branchLabel = getBranchLabel(inv.branchName);
    if (!byBranch[branchLabel]) byBranch[branchLabel] = makeAcc();

    const invRevenue = inv.totalAmount || 0;

    overall.revenue += invRevenue;
    overall.transactions += 1;
    byBranch[branchLabel].revenue += invRevenue;
    byBranch[branchLabel].transactions += 1;

    // Salesperson at invoice level (fallback if no line item salesperson)
    const invSp = (inv.masterSalesmanName || '').trim() || 'Tidak Ada';

    for (const item of (inv.detailItem || [])) {
      // Salesperson: prefer line item level, fallback to invoice level
      const sp = (item.salesmanName || invSp || '').trim() || 'Tidak Ada';

      // Warehouse from line item
      const wh = normalizeWarehouse(item.warehouse?.name || inv.branchName || '');

      const amount = item.totalPrice || (item.quantity * (item.unitPrice || 0)) || 0;
      const qty = item.quantity || 0;
      const itemName = (item.detailName || item.item?.name || '').trim();
      const brand = itemName ? itemName.split(/[\s-]/)[0].toUpperCase() : null;
      // Category from item object
      const cat = (item.item?.itemCategory?.name || item.item?.itemCategoryId
        ? `Kategori ${item.item?.itemCategoryId}` : 'Lainnya');

      accItem(overall, sp, amount, qty, itemName, brand, cat);
      accItem(byBranch[branchLabel], sp, amount, qty, itemName, brand, cat);

      if (wh) {
        if (!byStore[wh]) byStore[wh] = makeAcc();
        byStore[wh].revenue += amount;
        byStore[wh].transactions = null;
        accItem(byStore[wh], sp, amount, qty, itemName, brand, cat);
      }
    }
  }

  const branchSummary = Object.entries(byBranch)
    .map(([name, acc]) => ({
      name,
      revenue: acc.revenue,
      transactions: acc.transactions,
      stores: Object.entries(byStore)
        .filter(([wCode]) => (WAREHOUSE_BRANCHES[name] || []).includes(wCode))
        .map(([code, wAcc]) => ({ code, revenue: wAcc.revenue, ...finalizeAcc(wAcc) }))
        .sort((a, b) => b.revenue - a.revenue),
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    period,
    summary: {
      revenue: overall.revenue,
      profit: 0, profitMargin: 0,
      transactions: overall.transactions,
    },
    branchSummary,
    branches: Object.fromEntries(
      Object.entries(byBranch).map(([name, acc]) => [name, finalizeAcc(acc)])
    ),
    ...finalizeAcc(overall),
  };
}

function makeAcc() {
  return { revenue: 0, transactions: 0, salesMap: {}, itemMap: {}, brandMap: {}, catMap: {} };
}

function accItem(acc, sp, amount, qty, itemName, brand, cat) {
  if (!acc.salesMap[sp]) acc.salesMap[sp] = { revenue: 0, qty: 0 };
  acc.salesMap[sp].revenue += amount;
  acc.salesMap[sp].qty += qty;

  if (itemName) {
    if (!acc.itemMap[itemName]) acc.itemMap[itemName] = { qty: 0, revenue: 0 };
    acc.itemMap[itemName].qty += qty;
    acc.itemMap[itemName].revenue += amount;
    if (brand) acc.brandMap[brand] = (acc.brandMap[brand] || 0) + qty;
  }
  if (cat) acc.catMap[cat] = (acc.catMap[cat] || 0) + qty;
}

function finalizeAcc(acc) {
  return {
    salesList: Object.entries(acc.salesMap)
      .map(([name, d]) => ({ name, revenue: d.revenue, qty: d.qty }))
      .sort((a, b) => b.revenue - a.revenue),
    topItems: Object.entries(acc.itemMap)
      .map(([name, d]) => ({ name, qty: d.qty, revenue: d.revenue }))
      .sort((a, b) => b.qty - a.qty).slice(0, 10),
    topBrands: Object.entries(acc.brandMap)
      .map(([name, qty]) => ({ name, qty }))
      .sort((a, b) => b.qty - a.qty).slice(0, 10),
    categoryList: Object.entries(acc.catMap)
      .map(([name, units]) => ({ name, units }))
      .sort((a, b) => b.units - a.units),
  };
}

function getThisMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
