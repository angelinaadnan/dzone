// Cloudflare Pages Function — proxy ke Accurate Online API
// Secrets yang dibutuhkan (set via Cloudflare Dashboard → Settings → Environment Variables):
//   ACCURATE_TOKEN_ADL   = API token database PT ANUGERAH DIGITAL LESTARI (PPN)
//   ACCURATE_TOKEN_GROUP = API token database GROUP (non-PPN)
//   ACCURATE_API_KEY     = secret key untuk validasi request dari dashboard (bebas isi)

const ACCURATE_BASE = 'https://api.accurate.id/accurate/api';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  // Validasi API key sederhana
  const apiKey = url.searchParams.get('key') || request.headers.get('X-API-Key');
  if (env.ACCURATE_API_KEY && apiKey !== env.ACCURATE_API_KEY) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  }

  const period = url.searchParams.get('period') || getThisMonth(); // format: "2026-08"

  try {
    const [year, month] = period.split('-').map(Number);
    const startDate = `${year}-${String(month).padStart(2,'0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2,'0')}-${lastDay}`;

    // Fetch dari kedua database paralel
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

// ─── Fetch semua halaman invoice dari Accurate ───────────────────────────────
async function fetchAllInvoices(token, startDate, endDate) {
  const all = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    const params = new URLSearchParams({
      fields: [
        'number', 'transactionDate', 'customerName',
        'grandTotal', 'totalAmount', 'branchName',
        'salesperson', 'detailItem',
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

    // Stop jika sudah dapat semua atau halaman terakhir
    if (json.d.length < pageSize || all.length >= (json.total || Infinity)) break;
    page++;

    // Safety limit 20 halaman = 2000 invoice
    if (page > 20) break;
  }

  return all;
}

// ─── Agregasi data untuk dashboard ───────────────────────────────────────────
function aggregateData(invoices, period) {
  let totalRevenue = 0;
  let totalProfit = 0;
  let totalTransactions = invoices.length;

  const salesMap = {};   // salesperson → { revenue, profit, qty }
  const itemMap = {};    // itemName → { qty, revenue }
  const brandMap = {};   // brand (kata pertama item) → { qty }
  const catMap = {};     // category → { qty }

  for (const inv of invoices) {
    const invRevenue = inv.grandTotal || inv.totalAmount || 0;
    totalRevenue += invRevenue;
    totalProfit += inv.profitAmount || 0;

    const items = inv.detailItem || [];

    for (const item of items) {
      // Salesperson: di item atau di header invoice
      const sp = (item.salespersonName || item.salesperson?.name
        || inv.salesperson?.name || '').trim() || 'Tidak Ada';

      const amount = item.amount || (item.quantity * item.unitPrice) || 0;
      const qty = item.quantity || 0;
      const profit = item.profitAmount || 0;

      // Per salesperson
      if (!salesMap[sp]) salesMap[sp] = { revenue: 0, profit: 0, qty: 0 };
      salesMap[sp].revenue += amount;
      salesMap[sp].profit += profit;
      salesMap[sp].qty += qty;

      // Per item
      const itemName = (item.itemName || item.name || '').trim();
      if (itemName) {
        if (!itemMap[itemName]) itemMap[itemName] = { qty: 0, revenue: 0 };
        itemMap[itemName].qty += qty;
        itemMap[itemName].revenue += amount;

        // Brand = kata pertama dari nama item (misal "LENOVO", "EPSON", dll)
        const brand = itemName.split(/[\s-]/)[0].toUpperCase();
        if (!brandMap[brand]) brandMap[brand] = 0;
        brandMap[brand] += qty;
      }

      // Per kategori
      const cat = (item.itemCategory?.name || item.categoryName || 'Lainnya').trim();
      if (!catMap[cat]) catMap[cat] = 0;
      catMap[cat] += qty;
    }
  }

  // Sortir
  const salesList = Object.entries(salesMap)
    .map(([name, d]) => ({ name, revenue: d.revenue, profit: d.profit, qty: d.qty }))
    .sort((a, b) => b.revenue - a.revenue);

  const topItems = Object.entries(itemMap)
    .map(([name, d]) => ({ name, qty: d.qty, revenue: d.revenue }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);

  const topBrands = Object.entries(brandMap)
    .map(([name, qty]) => ({ name, qty }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);

  const categoryList = Object.entries(catMap)
    .map(([name, units]) => ({ name, units }))
    .sort((a, b) => b.units - a.units);

  const profitMargin = totalRevenue > 0
    ? parseFloat((totalProfit / totalRevenue * 100).toFixed(1))
    : 0;

  return {
    period,
    summary: {
      revenue: totalRevenue,
      profit: totalProfit,
      profitMargin,
      transactions: totalTransactions,
    },
    salesList,
    topItems,
    topBrands,
    categoryList,
  };
}

function getThisMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
