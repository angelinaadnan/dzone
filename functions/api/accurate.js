// Cloudflare Pages Function — proxy ke Accurate Online API
// Secrets (set via Cloudflare Dashboard → Settings → Environment Variables):
//   ACCURATE_TOKEN_ADL   = API token DB PT ANUGERAH DIGITAL LESTARI (PPN)
//   ACCURATE_TOKEN_GROUP = API token DB GROUP (non-PPN)
//   ACCURATE_API_KEY     = secret key untuk validasi request dari dashboard

const ACCURATE_BASE = 'https://api.accurate.id/accurate/api';

// Branch prefix → display name
const BRANCH_LABELS = {
  'TC': 'Tangerang',
  'PS': 'Poins',
  'M2': 'Mangga Dua',
};

// All known branch codes → their prefix
const BRANCH_CODES = [
  'TC DZ', 'TC NMC', 'TC HOI',
  'PS NMC',
  'M2 DZ', 'M2 BIG', 'M2 ADL',
];

function getBranchLabel(branchName) {
  if (!branchName) return 'Lainnya';
  const prefix = branchName.trim().split(/\s+/)[0].toUpperCase();
  return BRANCH_LABELS[prefix] || branchName;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  // Simple API key guard
  const apiKey = url.searchParams.get('key') || request.headers.get('X-API-Key');
  if (env.ACCURATE_API_KEY && apiKey !== env.ACCURATE_API_KEY) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  }

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

// ─── Fetch all pages of invoices from Accurate ───────────────────────────────
async function fetchAllInvoices(token, startDate, endDate) {
  const all = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    const params = new URLSearchParams({
      fields: [
        'number', 'transactionDate', 'customerName',
        'grandTotal', 'totalAmount', 'profitAmount',
        'branchName', 'salesperson', 'detailItem',
      ].join(','),
      'filter.startDate': startDate,
      'filter.endDate': endDate,
      page: String(page),
      pageSize: String(pageSize),
    });

    const resp = await fetch(`${ACCURATE_BASE}/sales-invoice/list.do?${params}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Accurate API ${resp.status}: ${txt.slice(0, 200)}`);
    }

    const json = await resp.json();
    if (!json.s || !json.d || json.d.length === 0) break;

    all.push(...json.d);

    if (json.d.length < pageSize || all.length >= (json.total || Infinity)) break;
    page++;
    if (page > 20) break; // safety: 2000 invoices max
  }

  return all;
}

// ─── Aggregate into overall + per-branch breakdowns ──────────────────────────
function aggregateData(invoices, period) {
  // overall accumulators
  const overall = makeAccumulators();

  // per-branch accumulators: key = 'Tangerang' | 'Poins' | 'Mangga Dua' | 'Lainnya'
  const byBranch = {};

  for (const inv of invoices) {
    const branchLabel = getBranchLabel(inv.branchName);
    if (!byBranch[branchLabel]) byBranch[branchLabel] = makeAccumulators();

    const invRevenue = inv.grandTotal || inv.totalAmount || 0;
    const invProfit = inv.profitAmount || 0;

    overall.revenue += invRevenue;
    overall.profit += invProfit;
    overall.transactions += 1;
    byBranch[branchLabel].revenue += invRevenue;
    byBranch[branchLabel].profit += invProfit;
    byBranch[branchLabel].transactions += 1;

    const items = inv.detailItem || [];
    for (const item of items) {
      const sp = (item.salespersonName || item.salesperson?.name
        || inv.salesperson?.name || '').trim() || 'Tidak Ada';
      const amount = item.amount || (item.quantity * (item.unitPrice || 0)) || 0;
      const qty = item.quantity || 0;
      const profit = item.profitAmount || 0;
      const itemName = (item.itemName || item.name || '').trim();
      const brand = itemName ? itemName.split(/[\s-]/)[0].toUpperCase() : null;
      const cat = (item.itemCategory?.name || item.categoryName || 'Lainnya').trim();

      accumulate(overall, sp, amount, qty, profit, itemName, brand, cat);
      accumulate(byBranch[branchLabel], sp, amount, qty, profit, itemName, brand, cat);
    }
  }

  const branchSummary = Object.entries(byBranch)
    .map(([name, acc]) => ({
      name,
      revenue: acc.revenue,
      profit: acc.profit,
      profitMargin: acc.revenue > 0 ? parseFloat((acc.profit / acc.revenue * 100).toFixed(1)) : 0,
      transactions: acc.transactions,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    period,
    summary: finalizeSummary(overall),
    branchSummary,
    branches: Object.fromEntries(
      Object.entries(byBranch).map(([name, acc]) => [name, finalizeAccumulators(acc)])
    ),
    ...finalizeAccumulators(overall),
  };
}

function makeAccumulators() {
  return {
    revenue: 0, profit: 0, transactions: 0,
    salesMap: {}, itemMap: {}, brandMap: {}, catMap: {},
  };
}

function accumulate(acc, sp, amount, qty, profit, itemName, brand, cat) {
  if (!acc.salesMap[sp]) acc.salesMap[sp] = { revenue: 0, profit: 0, qty: 0 };
  acc.salesMap[sp].revenue += amount;
  acc.salesMap[sp].profit += profit;
  acc.salesMap[sp].qty += qty;

  if (itemName) {
    if (!acc.itemMap[itemName]) acc.itemMap[itemName] = { qty: 0, revenue: 0 };
    acc.itemMap[itemName].qty += qty;
    acc.itemMap[itemName].revenue += amount;

    if (brand) {
      acc.brandMap[brand] = (acc.brandMap[brand] || 0) + qty;
    }
  }

  acc.catMap[cat] = (acc.catMap[cat] || 0) + qty;
}

function finalizeSummary(acc) {
  return {
    revenue: acc.revenue,
    profit: acc.profit,
    profitMargin: acc.revenue > 0 ? parseFloat((acc.profit / acc.revenue * 100).toFixed(1)) : 0,
    transactions: acc.transactions,
  };
}

function finalizeAccumulators(acc) {
  const salesList = Object.entries(acc.salesMap)
    .map(([name, d]) => ({ name, revenue: d.revenue, profit: d.profit, qty: d.qty }))
    .sort((a, b) => b.revenue - a.revenue);

  const topItems = Object.entries(acc.itemMap)
    .map(([name, d]) => ({ name, qty: d.qty, revenue: d.revenue }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);

  const topBrands = Object.entries(acc.brandMap)
    .map(([name, qty]) => ({ name, qty }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);

  const categoryList = Object.entries(acc.catMap)
    .map(([name, units]) => ({ name, units }))
    .sort((a, b) => b.units - a.units);

  return { salesList, topItems, topBrands, categoryList };
}

function getThisMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
