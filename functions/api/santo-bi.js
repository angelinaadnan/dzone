// CF Pages Function — Santo Business Analyst (Accurate-based)
// GET /api/santo-bi?year=YYYY&month=M
// Secrets: ACCURATE_TOKEN_ADL, ACCURATE_TOKEN_GROUP, ACCURATE_APP_KEY, ACCURATE_SIG_SECRET

const ACCURATE_BASE     = 'https://api.accurate.id/accurate/api';
const ACCURATE_BASE_ALT = 'https://iris.accurate.id/accurate/api';
const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

const WHITELIST = new Set([
  'APRIL','ULIN','RIA','FAJAR','ARYA','MONA','GUSTI','RIZAL','DEFA','SANDI',
  'DARTIK','TITI','ADE','LILI',
]);

// Item code prefix → product category
const CODE_CAT = {
  NB: 'notebook', PC: 'pc_aio', PR: 'printer', MT: 'monitor', PJ: 'projector',
};

// Segment 2 prefix → brand name (deterministic, no guessing)
const BRAND_LOOKUP = {
  // HP
  HP: 'HP', HPC: 'HP',
  // Acer
  ACR: 'Acer', ACL: 'Acer', ACE: 'Acer', ACS: 'Acer', AIO: 'Acer',
  // Lenovo
  LNV: 'Lenovo', LEN: 'Lenovo', THK: 'Lenovo', IDP: 'Lenovo', LOQ: 'Lenovo',
  // ASUS
  ASU: 'ASUS', AUS: 'ASUS', ASV: 'ASUS',
  // Dell
  DEL: 'Dell', DLL: 'Dell', INS: 'Dell', LAT: 'Dell', VOS: 'Dell',
  // MSI
  MSI: 'MSI',
  // Apple
  APL: 'Apple', MAC: 'Apple',
  // Samsung
  SAM: 'Samsung', SNG: 'Samsung', SGM: 'Samsung',
  // Toshiba / Dynabook
  TOS: 'Toshiba', DYN: 'Toshiba',
  // Epson
  EPS: 'Epson', EPN: 'Epson',
  // Canon
  CAN: 'Canon', CNO: 'Canon',
  // Brother
  BRT: 'Brother', BTH: 'Brother',
  // Xerox
  XER: 'Xerox',
  // LG
  LGE: 'LG', LGM: 'LG',
  // Philips
  PHI: 'Philips', PHL: 'Philips',
  // AOC
  AOC: 'AOC',
  // BenQ
  BEN: 'BenQ', BNQ: 'BenQ',
  // ViewSonic
  VSN: 'ViewSonic', VIE: 'ViewSonic',
  // Iiyama
  IIY: 'Iiyama',
};

function extractBrand(itemNo) {
  if (!itemNo) return null;
  const segs = itemNo.split('-');
  if (segs.length < 2) return null;
  const seg = segs[1].toUpperCase();
  return BRAND_LOOKUP[seg.slice(0, 3)] || BRAND_LOOKUP[seg.slice(0, 2)] || null;
}

function extractCat(itemNo) {
  if (!itemNo) return 'other';
  return CODE_CAT[itemNo.split('-')[0].toUpperCase()] || 'other';
}

function normalizeName(raw) {
  if (!raw) return null;
  return raw.trim().split(/\s+/)[0].toUpperCase();
}

async function makeSignature(timestamp, sigSecret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(sigSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(timestamp)));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function authHeaders(token, appKey, sig, ts) {
  return {
    Authorization: `Bearer ${token}`,
    'X-Api-Key': appKey,
    'X-Api-Timestamp': String(ts),
    'X-Api-Signature': sig,
    Accept: 'application/json',
    'User-Agent': 'DZone-BI/2.0',
  };
}

async function fetchPnL(token, appKey, sigSecret, startDate, endDate) {
  try {
    const ts  = Date.now();
    const sig = sigSecret ? await makeSignature(ts, sigSecret) : '';
    const params = new URLSearchParams({ startDate, endDate, pageSize: '100' });
    let resp = await fetch(`${ACCURATE_BASE}/report/profit-loss.do?${params}`, {
      headers: authHeaders(token, appKey, sig, ts),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok && resp.status >= 500) {
      const ts2 = Date.now(), sig2 = sigSecret ? await makeSignature(ts2, sigSecret) : '';
      resp = await fetch(`${ACCURATE_BASE_ALT}/report/profit-loss.do?${params}`, {
        headers: authHeaders(token, appKey, sig2, ts2),
        signal: AbortSignal.timeout(15000),
      });
    }
    if (!resp.ok) return null;
    const json = await resp.json();
    if (!json.s) return null;
    let revenue = 0, cogs = 0, grossProfit = 0;
    for (const row of (json.d || [])) {
      const desc = row['profitLoss.description'] || '';
      const bal  = row['profitLoss.balance']     || 0;
      if (desc.trim() === 'Jumlah Pendapatan')                                            revenue     = bal;
      if (desc.includes('Beban Pokok Penjualan') && row['profitLoss.lineType'] === 'LIST') cogs        = bal;
      if (desc.includes('LABA KOTOR'))                                                    grossProfit = bal;
    }
    return {
      revenue,
      cogs,
      grossProfit,
      grossMargin: revenue > 0 ? +(grossProfit / revenue * 100).toFixed(2) : 0,
    };
  } catch { return null; }
}

async function fetchInvoices(token, appKey, sigSecret, startDate, endDate, maxPages = 15) {
  const all = [];
  let page = 1, totalRecords = 0, fetchedPages = 0;
  while (page <= maxPages) {
    try {
      const ts  = Date.now();
      const sig = sigSecret ? await makeSignature(ts, sigSecret) : '';
      const params = new URLSearchParams({
        fields:             'number,transDate,totalAmount,branchName,masterSalesmanName,detailItem',
        'filter.startDate': startDate,
        'filter.endDate':   endDate,
        page:     String(page),
        pageSize: '200',
      });
      let resp = await fetch(`${ACCURATE_BASE}/sales-invoice/list.do?${params}`, {
        headers: authHeaders(token, appKey, sig, ts),
        signal: AbortSignal.timeout(20000),
      });
      if (!resp.ok && resp.status >= 500) {
        const ts2 = Date.now(), sig2 = sigSecret ? await makeSignature(ts2, sigSecret) : '';
        resp = await fetch(`${ACCURATE_BASE_ALT}/sales-invoice/list.do?${params}`, {
          headers: authHeaders(token, appKey, sig2, ts2),
          signal: AbortSignal.timeout(20000),
        });
      }
      if (!resp.ok) break;
      const json = await resp.json();
      if (!json.s) break;
      const rows = json.d || [];
      if (!rows.length) break;
      all.push(...rows);
      totalRecords = json.sp?.pageCount || totalRecords;
      fetchedPages = page;
      // pageCount is total RECORDS — stop when all collected or on a truly empty next page
      if (all.length >= totalRecords) break;
      page++;
    } catch { break; }
  }
  return { invoices: all, totalRecords, fetchedPages };
}

function aggregate(invoices) {
  const salesMap   = {};
  const branchMap  = {};
  const productMap = {};
  const brandMap   = {};
  let   totalUnits = 0;

  for (const inv of invoices) {
    const invSp     = normalizeName(inv.masterSalesmanName || inv.masterSalesman?.name);
    const invBranch = (inv.branchName || inv.branch?.name || '').trim() || null;
    const items     = inv.detailItem || [];

    if (!items.length) {
      // Revenue-only (no line items)
      if (invSp && WHITELIST.has(invSp)) {
        if (!salesMap[invSp]) salesMap[invSp] = { revenue: 0, qty: 0, branches: new Set() };
        salesMap[invSp].revenue += parseFloat(inv.totalAmount) || 0;
        if (invBranch) salesMap[invSp].branches.add(invBranch);
      }
      if (invBranch) {
        if (!branchMap[invBranch]) branchMap[invBranch] = { revenue: 0, qty: 0, sales: new Set() };
        branchMap[invBranch].revenue += parseFloat(inv.totalAmount) || 0;
      }
      continue;
    }

    for (const it of items) {
      const sp     = normalizeName(it.salesmanName || it.salesman?.name) || invSp;
      const branch = invBranch;
      const qty    = parseFloat(it.quantity)   || 0;
      const rev    = parseFloat(it.totalPrice) || (qty * (parseFloat(it.unitPrice) || 0));
      const no     = (it.item?.no || it.no || '').trim();
      const nm     = (it.detailName || it.item?.name || it.itemName || '').trim();
      const cat    = extractCat(no);
      const brand  = extractBrand(no);

      totalUnits += qty;

      if (sp && WHITELIST.has(sp)) {
        if (!salesMap[sp]) salesMap[sp] = { revenue: 0, qty: 0, branches: new Set() };
        salesMap[sp].revenue += rev;
        salesMap[sp].qty     += qty;
        if (branch) salesMap[sp].branches.add(branch);
      }

      if (branch) {
        if (!branchMap[branch]) branchMap[branch] = { revenue: 0, qty: 0, sales: new Set() };
        branchMap[branch].revenue += rev;
        branchMap[branch].qty     += qty;
        if (sp && WHITELIST.has(sp)) branchMap[branch].sales.add(sp);
      }

      if (no && cat !== 'other') {
        if (!productMap[no]) productMap[no] = { name: nm || no, cat, qty: 0, revenue: 0 };
        productMap[no].qty     += qty;
        productMap[no].revenue += rev;
      }

      if (brand && cat !== 'other') {
        if (!brandMap[cat]) brandMap[cat] = {};
        brandMap[cat][brand] = (brandMap[cat][brand] || 0) + qty;
      }
    }
  }

  const salesList = Object.entries(salesMap)
    .map(([name, d]) => ({
      name,
      revenue:  Math.round(d.revenue),
      qty:      Math.round(d.qty),
      branches: [...d.branches].sort(),
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const branchList = Object.entries(branchMap)
    .map(([name, d]) => ({
      name,
      revenue: Math.round(d.revenue),
      qty:     Math.round(d.qty),
      sales:   [...d.sales].sort(),
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const TOP = { notebook: 10, pc_aio: 3, printer: 3, monitor: 3, projector: 3 };
  const products = {};
  for (const [code, d] of Object.entries(productMap)) {
    if (!products[d.cat]) products[d.cat] = [];
    products[d.cat].push({ code, name: d.name, qty: Math.round(d.qty), revenue: Math.round(d.revenue) });
  }
  for (const cat of Object.keys(products)) {
    products[cat].sort((a, b) => b.qty - a.qty);
    products[cat] = products[cat].slice(0, TOP[cat] || 3);
  }

  const brands = {};
  for (const [cat, bmap] of Object.entries(brandMap)) {
    brands[cat] = Object.entries(bmap)
      .map(([brand, qty]) => ({ brand, qty: Math.round(qty) }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 8);
  }

  return { salesList, branchList, products, brands, totalUnits: Math.round(totalUnits) };
}

function toDMY(y, m, d) {
  return `${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}/${y}`;
}

function priorMonths(year, month, count) {
  const result = [];
  for (let i = count - 1; i >= 0; i--) {
    let y = year, m = month - i;
    while (m <= 0) { m += 12; y--; }
    const lastDay = new Date(y, m, 0).getDate();
    result.push({
      label: `${y}-${String(m).padStart(2,'0')}`,
      start: toDMY(y, m, 1),
      end:   toDMY(y, m, lastDay),
    });
  }
  return result;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url    = new URL(request.url);
  const year   = parseInt(url.searchParams.get('year')  || new Date().getFullYear(), 10);
  const month  = parseInt(url.searchParams.get('month') || (new Date().getMonth() + 1), 10);
  const appKey = env.ACCURATE_APP_KEY     || '';
  const sigSec = env.ACCURATE_SIG_SECRET  || '';
  const tokADL = env.ACCURATE_TOKEN_ADL   || '';
  const tokGRP = env.ACCURATE_TOKEN_GROUP || '';

  if (!appKey || !tokADL) {
    return new Response(JSON.stringify({ available: false, reason: 'not_configured' }), { headers: CORS });
  }

  // Debug mode: return raw first invoice to diagnose field names
  if (url.searchParams.get('debug') === '1') {
    const lastDay = new Date(year, month, 0).getDate();
    const invStart = `${year}-${String(month).padStart(2,'0')}-01`;
    const invEnd   = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
    const ts = Date.now(), sig = await makeSignature(ts, sigSec);
    const params = new URLSearchParams({
      fields: 'number,transDate,totalAmount,branchName,masterSalesmanName,detailItem',
      'filter.startDate': invStart, 'filter.endDate': invEnd,
      page: '1', pageSize: '3',
    });
    const r = await fetch(`${ACCURATE_BASE}/sales-invoice/list.do?${params}`, {
      headers: authHeaders(tokADL, appKey, sig, ts),
    });
    const j = await r.json();
    const rows = (j.d || []).map(inv => ({
      number: inv.number, totalAmount: inv.totalAmount,
      masterSalesmanName: inv.masterSalesmanName,
      masterSalesman: inv.masterSalesman,
      branchName: inv.branchName, branch: inv.branch,
      detailItemCount: (inv.detailItem || []).length,
      firstItem: (inv.detailItem || [])[0],
      allKeys: Object.keys(inv),
    }));
    return new Response(JSON.stringify({ s: j.s, sp: j.sp, rows }), { headers: CORS });
  }

  const cache    = caches.default;
  const cacheKey = new Request(`https://santo-bi-v4/${year}/${month}`);
  const cached   = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const months    = priorMonths(year, month, 6);
    const curMonth  = months[5];
    // Invoice API requires yyyy-MM-dd; P&L requires dd/MM/yyyy (different endpoints)
    const lastDay    = new Date(year, month, 0).getDate();
    const invStart   = `${year}-${String(month).padStart(2,'0')}-01`;
    const invEnd     = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

    const [adlPnlArr, grpPnlArr, invADL, invGRP] = await Promise.all([
      Promise.all(months.map(m => fetchPnL(tokADL, appKey, sigSec, m.start, m.end))),
      Promise.all(months.map(m => fetchPnL(tokGRP, appKey, sigSec, m.start, m.end))),
      fetchInvoices(tokADL, appKey, sigSec, invStart, invEnd),
      fetchInvoices(tokGRP, appKey, sigSec, invStart, invEnd),
    ]);

    const adlPnl = adlPnlArr[5];
    const grpPnl = grpPnlArr[5];
    const aggADL = aggregate(invADL.invoices);
    const aggGRP = aggregate(invGRP.invoices);

    const revTrendADL = months.map((m, i) => ({ label: m.label, revenue: Math.round(adlPnlArr[i]?.revenue || 0) }));
    const revTrendGRP = months.map((m, i) => ({ label: m.label, revenue: Math.round(grpPnlArr[i]?.revenue || 0) }));

    const result = {
      available: true,
      year, month,
      adl: {
        label: 'PT Anugerah Digital Lestari',
        dbId:  74419,
        pnl:   adlPnl ? {
          revenue:     Math.round(adlPnl.revenue),
          cogs:        Math.round(adlPnl.cogs),
          grossProfit: Math.round(adlPnl.grossProfit),
          grossMargin: adlPnl.grossMargin,
          totalUnits:  aggADL.totalUnits,
        } : null,
        revenueTrend: revTrendADL,
        salesList:    aggADL.salesList,
        branchList:   aggADL.branchList,
        products:     aggADL.products,
        brands:       aggADL.brands,
        _pages:       `${invADL.fetchedPages}/${invADL.totalRecords}`,
      },
      group: {
        label: 'Group (Non-PPN)',
        dbId:  131948,
        pnl:   grpPnl ? {
          revenue:     Math.round(grpPnl.revenue),
          cogs:        Math.round(grpPnl.cogs),
          grossProfit: Math.round(grpPnl.grossProfit),
          grossMargin: grpPnl.grossMargin,
          totalUnits:  aggGRP.totalUnits,
        } : null,
        revenueTrend: revTrendGRP,
        salesList:    aggGRP.salesList,
        branchList:   aggGRP.branchList,
        products:     aggGRP.products,
        brands:       aggGRP.brands,
        _pages:       `${invGRP.fetchedPages}/${invGRP.totalRecords}`,
      },
    };

    const resp = new Response(JSON.stringify(result), {
      headers: { ...CORS, 'Cache-Control': 's-maxage=3600' },
    });
    context.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    return new Response(JSON.stringify({ available: false, reason: 'error', details: e.message }), { headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
  });
}
