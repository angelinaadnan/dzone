// Cloudflare Pages Function — proxy ke Accurate Online API
// Secrets (set via Cloudflare Dashboard → Settings → Environment Variables):
//   ACCURATE_TOKEN_ADL   = API token DB PT ANUGERAH DIGITAL LESTARI (PPN)
//   ACCURATE_TOKEN_GROUP = API token DB GROUP (non-PPN)
//   ACCURATE_API_KEY     = secret key untuk validasi request dari dashboard

const ACCURATE_BASE = 'https://api.accurate.id/accurate/api';
const ACCURATE_BASE_ALT = 'https://iris.accurate.id/accurate/api';

// Branch prefix → display name
const BRANCH_LABELS = { TC: 'Tangerang', PS: 'Poins', M2: 'Mangga Dua' };

// Invoice branch codes per branch
const INVOICE_BRANCHES = {
  Tangerang:  ['TC DZ', 'TC NMC', 'TC HOI'],
  Poins:      ['PS NMC'],
  'Mangga Dua': ['M2 ADL'],
};

// Warehouse codes per branch (item level — includes M2 DZ, M2 BIG)
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

// Normalize warehouse name: "TC - DZ" → "TC DZ", "TC DZ" → "TC DZ"
function normalizeWarehouse(name) {
  if (!name) return '';
  return name.replace(/\s*-\s*/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const period = url.searchParams.get('period') || getThisMonth();

  try {
    const [year, month] = period.split('-').map(Number);
    const startDate = `${year}-${String(month).padStart(2,'0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2,'0')}-${lastDay}`;

    const [invAdl, invGroup] = await Promise.all([
      env.ACCURATE_TOKEN_ADL
        ? fetchAllInvoices(env.ACCURATE_TOKEN_ADL, startDate, endDate)
        : Promise.resolve([]),
      env.ACCURATE_TOKEN_GROUP
        ? fetchAllInvoices(env.ACCURATE_TOKEN_GROUP, startDate, endDate)
        : Promise.resolve([]),
    ]);

    const allInvoices = [...invAdl, ...invGroup];

    // Debug mode: ?debug=1 returns raw first invoice to check field names
    if (url.searchParams.get('debug') === '1') {
      return new Response(JSON.stringify({
        totalInvoices: allInvoices.length,
        firstInvoice: allInvoices[0] || null,
        firstItem: allInvoices[0]?.detailItem?.[0] || null,
        period, startDate, endDate,
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
async function fetchAllInvoices(token, startDate, endDate) {
  const all = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    // No 'fields' restriction — let API return all fields so we get everything
    const params = new URLSearchParams({
      'filter.startDate': startDate,
      'filter.endDate': endDate,
      sp: String(page),      // Accurate uses 'sp' for page
      l: String(pageSize),   // Accurate uses 'l' for limit
    });

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'DZone-Dashboard/1.0',
    };

    let resp = await fetch(`${ACCURATE_BASE}/sales-invoice/list.do?${params}`, { headers });

    // Fallback ke iris.accurate.id jika api.accurate.id error (Cloudflare 530)
    if (!resp.ok && resp.status >= 500) {
      resp = await fetch(`${ACCURATE_BASE_ALT}/sales-invoice/list.do?${params}`, { headers });
    }

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Accurate API ${resp.status}: ${txt.slice(0, 300)}`);
    }

    const json = await resp.json();

    // Handle both {s, d} and {s, data} response formats
    const rows = json.d || json.data || [];
    if (!json.s || rows.length === 0) break;

    all.push(...rows);
    if (rows.length < pageSize || all.length >= (json.total || Infinity)) break;
    page++;
    if (page > 20) break;
  }

  return all;
}

// ─── Aggregate into overall + per-branch + per-store ─────────────────────────
function aggregateData(invoices, period) {
  const overall = makeAcc();
  const byBranch = {};   // 'Tangerang' | 'Poins' | 'Mangga Dua' → acc
  const byStore = {};    // 'TC DZ' | 'TC NMC' | ... → acc (warehouse-level from items)

  for (const inv of invoices) {
    const branchLabel = getBranchLabel(inv.branchName);
    if (!byBranch[branchLabel]) byBranch[branchLabel] = makeAcc();

    const invRevenue = inv.grandTotal || inv.totalAmount || 0;
    const invProfit = inv.profitAmount || 0;

    addRevenue(overall, invRevenue, invProfit);
    addRevenue(byBranch[branchLabel], invRevenue, invProfit);

    for (const item of (inv.detailItem || [])) {
      // Warehouse/gudang field — try multiple possible names from Accurate API
      const rawWh = item.warehouseName || item.warehouse?.name
        || item.gudangName || item.gudang?.name || '';
      const wh = normalizeWarehouse(rawWh) || normalizeWarehouse(inv.branchName || '');

      if (wh && !byStore[wh]) byStore[wh] = makeAcc();

      const sp = (item.salespersonName || item.salesperson?.name
        || inv.salesperson?.name || '').trim() || 'Tidak Ada';
      const amount = item.amount || (item.quantity * (item.unitPrice || 0)) || 0;
      const qty = item.quantity || 0;
      const profit = item.profitAmount || 0;
      const itemName = (item.itemName || item.name || '').trim();
      const brand = itemName ? itemName.split(/[\s-]/)[0].toUpperCase() : null;
      const cat = (item.itemCategory?.name || item.categoryName || 'Lainnya').trim();

      accItem(overall, sp, amount, qty, profit, itemName, brand, cat);
      accItem(byBranch[branchLabel], sp, amount, qty, profit, itemName, brand, cat);
      if (wh) {
        addRevenue(byStore[wh], 0, 0); // ensure entry exists
        accItem(byStore[wh], sp, amount, qty, profit, itemName, brand, cat);
        // store revenue comes from items since store = warehouse (item level)
        byStore[wh].revenue += amount;
        byStore[wh].profit += profit;
        byStore[wh].transactions = null; // can't count transactions at item level
      }
    }
  }

  // Build branch summary list
  const branchSummary = Object.entries(byBranch)
    .map(([name, acc]) => ({
      name,
      revenue: acc.revenue, profit: acc.profit,
      profitMargin: acc.revenue > 0 ? parseFloat((acc.profit/acc.revenue*100).toFixed(1)) : 0,
      transactions: acc.transactions,
      // stores within this branch, keyed by warehouse code
      stores: Object.entries(byStore)
        .filter(([wCode]) => (WAREHOUSE_BRANCHES[name] || []).some(s => wCode.startsWith(s.split(' ')[0]) && wCode === s))
        .map(([wCode, wAcc]) => ({
          code: wCode,
          revenue: wAcc.revenue,
          profit: wAcc.profit,
          ...finalizeAcc(wAcc),
        }))
        .sort((a, b) => b.revenue - a.revenue),
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    period,
    summary: {
      revenue: overall.revenue, profit: overall.profit,
      profitMargin: overall.revenue > 0 ? parseFloat((overall.profit/overall.revenue*100).toFixed(1)) : 0,
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
  return { revenue: 0, profit: 0, transactions: 0, salesMap: {}, itemMap: {}, brandMap: {}, catMap: {} };
}

function addRevenue(acc, rev, profit) {
  acc.revenue += rev;
  acc.profit += profit;
  acc.transactions += 1;
}

function accItem(acc, sp, amount, qty, profit, itemName, brand, cat) {
  if (!acc.salesMap[sp]) acc.salesMap[sp] = { revenue: 0, profit: 0, qty: 0 };
  acc.salesMap[sp].revenue += amount;
  acc.salesMap[sp].profit += profit;
  acc.salesMap[sp].qty += qty;

  if (itemName) {
    if (!acc.itemMap[itemName]) acc.itemMap[itemName] = { qty: 0, revenue: 0 };
    acc.itemMap[itemName].qty += qty;
    acc.itemMap[itemName].revenue += amount;
    if (brand) acc.brandMap[brand] = (acc.brandMap[brand] || 0) + qty;
  }
  acc.catMap[cat] = (acc.catMap[cat] || 0) + qty;
}

function finalizeAcc(acc) {
  return {
    salesList: Object.entries(acc.salesMap)
      .map(([name, d]) => ({ name, revenue: d.revenue, profit: d.profit, qty: d.qty }))
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
