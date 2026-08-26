// Cloudflare Pages Function — AI Business Analyst Insights
// GET /api/bi-insights?persona=Angel&year=2026&month=8
//
// Security design:
//  - CLAUDE_API_KEY stored as CF Pages encrypted secret only
//  - Persona boundary: each context builder whitelists only domain-relevant fields
//  - Finance fields (AR, DSO, collection, profit) only included for Liana
//  - No raw KPI object is passed to Claude — explicit sanitized context built per persona
//  - CF Cache API caches per (persona, year, month) for 1 hour
//  - Dashboard continues working normally if this endpoint fails

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const ID_MONTHS = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

// ── Formatting helpers (for readable prompt values) ──────────────────────────

function fRp(v) {
  if (v == null || v === '' || isNaN(Number(v))) return null;
  const n = Math.abs(Number(v));
  const s = Number(v) < 0 ? '-' : '';
  if (n >= 1e9) return `${s}Rp ${(n/1e9).toFixed(2)}M`;
  if (n >= 1e6) return `${s}Rp ${(n/1e6).toFixed(1)}jt`;
  return `${s}Rp ${Math.round(n).toLocaleString('id-ID')}`;
}

function fPct(v) {
  if (v == null || isNaN(Number(v))) return null;
  return `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)}%`;
}

function unavail(field) {
  return `[${field}: data tidak tersedia]`;
}

// ── SANTO context — Accurate BI: ADL + GROUP revenue, sales, branch, product ──
// Domain: Revenue, qty, sales ranking, branch ranking, product intelligence
// DATA SOURCE: connector /api/analytics/santo → sales_facts table
// DATA BOUNDARY:
//   INCLUDED  : entity-level revenue_gross & total_qty (ADL & GROUP separately)
//               per-sales revenue_gross & qty, per-branch revenue_gross & qty
//               product top-N by category (line_subtotal based)
//   EXCLUDED  : GP/COGS/margin per sales, GP/COGS/margin per branch (tidak tersedia)
//               brand intelligence (not derivable from item_no prefix)
//               Liana-domain: AR, DSO, collection, cashflow
function buildSantoContext(data, year, month) {
  if (!data || !data.adl) return { tersedia: false, keterangan: 'Data Santo tidak tersedia' };
  const mLabel = `${ID_MONTHS[parseInt(month)]} ${year}`;
  const adl = data.adl || {};
  const grp = data.group || {};

  function fmtEntitySummary(entity) {
    const s = entity.entity_summary;
    if (!s) return unavail('ringkasan entitas');
    return {
      omzet_gross: fRp(s.revenue_gross) ?? unavail('revenue'),
      jumlah_invoice: s.invoice_count ?? unavail('invoice count'),
      total_qty: s.total_qty ?? unavail('total qty'),
    };
  }

  function fmtRevenueTrend(trend) {
    if (!Array.isArray(trend) || !trend.length) return unavail('trend revenue');
    return trend.map(t => ({ bulan: t.month, omzet: fRp(t.revenue_gross), invoice: t.invoice_count }));
  }

  function fmtSalesRanking(list, top = 5) {
    if (!Array.isArray(list) || !list.length) return unavail('data performa sales');
    return list.slice(0, top).map((s, i) => ({
      rank: i + 1,
      nama: s.sales,
      omzet: fRp(s.revenue_gross),
      qty: s.total_qty,
      invoice: s.invoice_count,
    }));
  }

  function fmtBranchRanking(list, top = 5) {
    if (!Array.isArray(list) || !list.length) return unavail('data performa cabang');
    return list.slice(0, top).map((b, i) => ({
      rank: i + 1,
      cabang: b.branch,
      omzet: fRp(b.revenue_gross),
      qty: b.total_qty,
      invoice: b.invoice_count,
    }));
  }

  function fmtProductCategory(intel, cat, top) {
    const list = intel?.[cat];
    if (!Array.isArray(list) || !list.length) return unavail(`produk ${cat}`);
    return list.slice(0, top).map((p, i) => ({
      rank: i + 1,
      nama: p.item_name || p.item_no,
      kode: p.item_no,
      qty: p.total_qty,
      revenue: fRp(p.line_revenue),
    }));
  }

  return {
    persona: 'Santo',
    domain: 'Revenue, Sales, Cabang, Produk — Accurate Online (sales_facts)',
    periode: mLabel,
    catatan_data: [
      'Revenue yang ditampilkan adalah revenue_gross (incl PPN) dari tabel sales_facts.',
      'GP/laba per sales dan per cabang TIDAK tersedia. Jika ditanya, jawab tidak dapat diakses.',
      'Brand data tidak tersedia — item_no prefix hanya menunjukkan kategori produk, bukan brand.',
      'ADL dan Group adalah dua entitas terpisah — jangan bandingkan atau hitung kontribusi persen.',
    ],

    pt_adl: {
      label: 'PT Anugerah Digital Lestari (PPN, DB 74419)',
      ringkasan: fmtEntitySummary(adl),
      trend_revenue_6_bulan: fmtRevenueTrend(adl.revenue_trend),
      top_5_sales_by_omzet: fmtSalesRanking(adl.sales_ranking),
      top_5_cabang_by_omzet: fmtBranchRanking(adl.branch_ranking),
      produk_notebook_top5: fmtProductCategory(adl.product_intelligence, 'notebook', 5),
      produk_printer_top3: fmtProductCategory(adl.product_intelligence, 'printer', 3),
      produk_monitor_top3: fmtProductCategory(adl.product_intelligence, 'monitor', 3),
      produk_pc_aio_top3: fmtProductCategory(adl.product_intelligence, 'pc_aio', 3),
    },

    group_non_ppn: {
      label: 'Group Non-PPN (DB 131948)',
      ringkasan: fmtEntitySummary(grp),
      trend_revenue_6_bulan: fmtRevenueTrend(grp.revenue_trend),
      top_5_sales_by_omzet: fmtSalesRanking(grp.sales_ranking),
      top_5_cabang_by_omzet: fmtBranchRanking(grp.branch_ranking),
    },

    instruksi_ai: [
      'Analisis hanya berdasarkan data yang diberikan di konteks ini.',
      'DILARANG mengarang atau memperkirakan GP/laba per sales atau per cabang.',
      'Jika user meminta profit per sales, jawab: "Data laba per sales tidak tersedia."',
      'ADL dan Group adalah dua entitas terpisah — jangan bandingkan atau hitung kontribusi persen satu terhadap lainnya.',
      'Brand data tidak tersedia — jangan sebut atau perkirakan brand dari kode produk.',
    ],
  };
}

// ── ANGEL context — B2B Sales, Pipeline, Customer Retention ──────────────────
// Domain: Corporate B2B sales, quotation pipeline, customer retention
// EXCLUDES: Finance/AR/DSO/collection rate/company-wide revenue/profit
function buildAngelContext(data, year, month) {
  if (!data) return { tersedia: false, keterangan: 'Data Angel tidak tersedia dari server' };
  const mLabel = `${ID_MONTHS[parseInt(month)]} ${year}`;
  return {
    persona: 'Angel',
    domain: 'Penjualan Korporat B2B, Pipeline Penawaran, Customer Retention',
    periode: mLabel,
    pipeline_penawaran: data.pipeline ? {
      aktif: data.pipeline.total_count,
      nilai_pipeline: fRp(data.pipeline.total_value) ?? unavail('nilai pipeline'),
      converted_bulan_ini: data.pipeline.converted_this_period,
      converted_bulan_lalu: data.pipeline.converted_prior,
      conversion_rate: data.pipeline.conversion_rate != null ? `${data.pipeline.conversion_rate}%` : unavail('conversion rate'),
      conversion_rate_bulan_lalu: data.pipeline.conversion_rate_prior != null ? `${data.pipeline.conversion_rate_prior}%` : unavail('conversion rate bulan lalu'),
      ditolak: data.pipeline.rejected_count,
    } : unavail('data pipeline penawaran'),
    revenue_b2b_accurate: data.b2b_revenue ? {
      bulan_ini: fRp(data.b2b_revenue.revenue) ?? unavail('revenue B2B bulan ini'),
      bulan_lalu: fRp(data.b2b_revenue.prior),
      perubahan_mom: fPct(data.b2b_revenue.mom_pct) ?? unavail('perubahan B2B MoM'),
      jumlah_invoice: data.b2b_revenue.invoice_count,
      pelanggan_unik: data.b2b_revenue.unique_customers,
    } : unavail('data revenue B2B Accurate (connector mungkin offline)'),
    retensi_pelanggan: data.customer_retention ? {
      pelanggan_bulan_lalu: data.customer_retention.prior_customers,
      pelanggan_bulan_ini: data.customer_retention.current_customers,
      dipertahankan: data.customer_retention.retained,
      retention_rate: data.customer_retention.retention_rate != null ? `${data.customer_retention.retention_rate}%` : unavail('retention rate'),
      catatan: `Perbandingan ${data.customer_retention.prior_period} vs ${data.customer_retention.current_period}`,
    } : unavail('data retensi pelanggan'),
    pelanggan_baru: data.new_customers ? {
      baru_bulan_ini: data.new_customers.new_this_period,
      baru_bulan_lalu: data.new_customers.new_prior_period,
      total_unik_bulan_ini: data.new_customers.total_unique,
      b2b_unik: data.new_customers.b2b_unique,
    } : unavail('data pelanggan baru'),
    tren_b2b_3_bulan_terakhir: Array.isArray(data.b2b_revenue_trend) && data.b2b_revenue_trend.length > 0
      ? data.b2b_revenue_trend.slice(-3).map(t => ({
          bulan: t.month,
          revenue: fRp(t.revenue),
        }))
      : unavail('tren revenue B2B 3 bulan'),
    // Top 3 customers — business entities, revenue values only (no contact info)
    top_3_pelanggan_b2b: Array.isArray(data.top_customers) && data.top_customers.length > 0
      ? data.top_customers.slice(0, 3).map((c, i) => ({
          peringkat: i + 1,
          nama: c.name,
          jumlah_invoice: c.invoices,
          revenue: fRp(c.revenue),
        }))
      : unavail('top pelanggan B2B'),
  };
}

// ── LIANA context — Finance, Revenue, AR, Collection ─────────────────────────
// Domain: Full Finance scope (AR, DSO, collection rate, revenue, YoY)
// Liana is the ONLY persona that receives Finance fields
function buildLianaContext(data, year, month) {
  if (!data) return { tersedia: false, keterangan: 'Data Liana tidak tersedia dari server' };
  const mLabel = `${ID_MONTHS[parseInt(month)]} ${year}`;
  const acc = data.accurate;
  return {
    persona: 'Liana',
    domain: 'Keuangan, Revenue, Accounts Receivable, Collection Rate',
    periode: mLabel,
    revenue_mtd: acc?.revenue ? {
      total: fRp(acc.revenue.total) ?? unavail('revenue MTD'),
      bulan_lalu: fRp(acc.revenue.prior),
      perubahan_mom: fPct(acc.revenue.mom_pct) ?? unavail('perubahan revenue MoM'),
      jumlah_invoice: acc.revenue.invoice_count,
      rata_invoice: fRp(acc.revenue.avg_invoice),
    } : unavail('data revenue MTD (connector mungkin offline)'),
    collection_mtd: acc?.collection ? {
      total_terkumpul: fRp(acc.collection.total) ?? unavail('collection MTD'),
      collection_rate: acc.collection.collection_rate != null ? `${acc.collection.collection_rate}%` : unavail('collection rate MTD'),
      perubahan_mom: fPct(acc.collection.mom_pct),
    } : unavail('data collection MTD'),
    yoy_revenue: data.yoy_revenue ? {
      bulan_ini: fRp(data.yoy_revenue.current),
      tahun_lalu: fRp(data.yoy_revenue.prior_year),
      perubahan_yoy: fPct(data.yoy_revenue.yoy_pct) ?? unavail('perubahan YoY'),
      catatan: data.yoy_revenue.is_partial
        ? `Perbandingan prorata hingga ${data.yoy_revenue.data_through} vs ${data.yoy_revenue.prior_year_through} — bukan bulan penuh`
        : 'Perbandingan bulan penuh vs tahun lalu',
    } : unavail('data YoY revenue'),
    dso_hari: data.dso != null ? `${data.dso} hari` : unavail('DSO'),
    accounts_receivable: acc?.ar ? {
      total_outstanding: fRp(acc.ar.total),
      jumlah_invoice_outstanding: acc.ar.count,
      overdue_lebih_30_hari: fRp(acc.ar.over_30d),
      overdue_lebih_60_hari: fRp(acc.ar.over_60d),
      overdue_lebih_90_hari: fRp(acc.ar.over_90d),
      count_overdue_30: acc.ar.over_30d_count,
      count_overdue_60: acc.ar.over_60d_count,
      count_overdue_90: acc.ar.over_90d_count,
      status_alert: data.ar_alert?.status ?? null,
    } : unavail('data AR outstanding'),
    tren_collection_rate_6_bulan: Array.isArray(data.collection_rate_trend) && data.collection_rate_trend.length > 0
      ? data.collection_rate_trend.map(t => ({
          bulan: t.month,
          invoiced: fRp(t.invoiced),
          collected: fRp(t.collected),
          rate: t.collection_rate != null ? `${t.collection_rate}%` : null,
        }))
      : unavail('tren collection rate 6 bulan'),
    ytd: data.ytd ? {
      revenue_ytd: fRp(data.ytd.revenue_ytd),
      collected_ytd: fRp(data.ytd.collected_ytd),
      invoice_count_ytd: data.ytd.invoice_count_ytd,
    } : unavail('data YTD'),
    channel_split: Array.isArray(acc?.channel_split)
      ? acc.channel_split.map(c => ({
          channel: c.channel,
          revenue: fRp(c.revenue),
          jumlah_invoice: c.count,
        }))
      : unavail('channel split B2B vs marketplace'),
  };
}

// ── LUKAS context — Product, Online/Marketplace, Inventory ───────────────────
// Domain: Marketplace revenue, product performance, stock health
// EXCLUDES: Finance/AR/DSO/collection rate/company-wide revenue/profit
function buildLukasContext(data, year, month) {
  if (!data) return { tersedia: false, keterangan: 'Data Lukas tidak tersedia dari server' };
  const mLabel = `${ID_MONTHS[parseInt(month)]} ${year}`;
  const acc = data.accurate;
  if (!acc) return { tersedia: false, keterangan: 'Data Accurate (connector) tidak tersedia untuk Lukas' };
  return {
    persona: 'Lukas',
    domain: 'Produk, Online/Marketplace, Inventaris',
    periode: mLabel,
    revenue_marketplace_mtd: acc.channel_split?.online ? {
      bulan_ini: fRp(acc.channel_split.online.revenue) ?? unavail('revenue marketplace'),
      bulan_lalu: fRp(acc.channel_split.online.prior),
      perubahan_mom: fPct(acc.channel_split.online.mom_pct) ?? unavail('perubahan marketplace MoM'),
      jumlah_invoice: acc.channel_split.online.count,
    } : unavail('data revenue marketplace'),
    revenue_b2b_channel: acc.channel_split?.b2b ? {
      bulan_ini: fRp(acc.channel_split.b2b.revenue),
      perubahan_mom: fPct(acc.channel_split.b2b.mom_pct),
    } : unavail('data revenue B2B channel'),
    tren_marketplace_3_bulan_terakhir: Array.isArray(acc.marketplace_revenue_trend) && acc.marketplace_revenue_trend.length > 0
      ? acc.marketplace_revenue_trend.slice(-3).map(t => ({
          bulan: t.month,
          revenue: fRp(t.revenue),
        }))
      : unavail('tren marketplace 3 bulan terakhir'),
    status_stok: acc.stock ? {
      stockout_qty_nol: acc.stock.stockout_count,
      kritis_3_atau_kurang: acc.stock.critical_count,
      rendah_10_atau_kurang: acc.stock.low_count,
      total_item_inventaris: acc.stock.total_items,
    } : unavail('status stok'),
    top_5_item_revenue: Array.isArray(acc.top_items_by_revenue)
      ? acc.top_items_by_revenue.slice(0, 5).map(it => ({
          nama: it.name,
          qty_terjual: it.qty,
          revenue: fRp(it.revenue),
          jumlah_order: it.orders,
        }))
      : unavail('top item by revenue'),
    slow_moving_jumlah_item: Array.isArray(acc.slow_moving) ? acc.slow_moving.length : unavail('jumlah slow moving'),
    slow_moving_top3: Array.isArray(acc.slow_moving) && acc.slow_moving.length > 0
      ? acc.slow_moving.slice(0, 3).map(it => ({
          nama: it.name,
          stok_sisa: it.available,
          terjual_bulan_ini: it.sold_qty,
        }))
      : unavail('detail slow moving'),
  };
}

// ── JENNY context — Purchasing, Procurement, Inventory ───────────────────────
// Domain: PO tracking, supplier management, stock coverage, restock forecast
// EXCLUDES: Finance/AR/DSO/collection rate/company revenue/profit
function buildJennyContext(data, year, month) {
  if (!data) return { tersedia: false, keterangan: 'Data Jenny tidak tersedia dari server' };
  const mLabel = `${ID_MONTHS[parseInt(month)]} ${year}`;
  return {
    persona: 'Jenny',
    domain: 'Purchasing, Procurement, Inventaris',
    periode: mLabel,
    purchase_orders_mtd: data.purchasing ? {
      jumlah_po: data.purchasing.po_count,
      jumlah_po_bulan_lalu: data.purchasing.po_count_prior,
      perubahan_po_mom: fPct(data.purchasing.po_count_mom) ?? unavail('perubahan PO MoM'),
      nilai_total: fRp(data.purchasing.total_value) ?? unavail('nilai total PO'),
      nilai_bulan_lalu: fRp(data.purchasing.total_value_prior),
      perubahan_nilai_mom: fPct(data.purchasing.value_mom),
      status_po: data.purchasing.by_status,
      pending_jumlah: data.purchasing.pending_count,
      pending_nilai: fRp(data.purchasing.pending_value),
    } : unavail('data purchase orders MTD'),
    stock_coverage_30_hari: data.stock_coverage?.buckets ? {
      kritis_bawah_7_hari: data.stock_coverage.buckets.critical,
      warning_7_hingga_14_hari: data.stock_coverage.buckets.warning,
      caution_14_hingga_30_hari: data.stock_coverage.buckets.caution,
      healthy_di_atas_30_hari: data.stock_coverage.buckets.healthy,
      catatan: 'Berdasarkan velocity penjualan 30 hari terakhir. Item dengan nol penjualan dikecualikan.',
      item_paling_kritis_5: Array.isArray(data.stock_coverage.items)
        ? data.stock_coverage.items.slice(0, 5).map(it => ({
            nama: it.name,
            stok: it.available,
            coverage_hari: it.coverage_days,
            avg_jual_per_hari: it.avg_daily_sales != null ? +Number(it.avg_daily_sales).toFixed(2) : null,
          }))
        : unavail('detail item kritis'),
    } : unavail('data stock coverage'),
    status_stok_keseluruhan: data.stock ? {
      stockout: data.stock.stockout_count,
      kritis_stok_rendah: data.stock.critical_count,
      rendah: data.stock.low_count,
      total_item: data.stock.total_items,
    } : unavail('status stok keseluruhan'),
    top_5_supplier: Array.isArray(data.top_suppliers)
      ? data.top_suppliers.slice(0, 5).map(s => ({
          nama: s.name,
          jumlah_po: s.count,
          nilai: fRp(s.value),
        }))
      : unavail('data top supplier'),
    service_intakes: data.service_intakes ? {
      total: data.service_intakes.total,
      by_status: data.service_intakes.by_status,
    } : unavail('data service intakes'),
  };
}

// ── System prompts per persona ────────────────────────────────────────────────

const SYSTEM_PROMPTS = {
  Santo: `Kamu adalah AI Business Analyst untuk persona Santo di internal dashboard PT Anugerah Digital Lestari (Digitalzone Group).

SCOPE domain kamu: Revenue, omzet, performa sales, performa cabang, dan product intelligence berdasarkan data Accurate (sales_facts). Data mencakup PT ADL dan Group Non-PPN secara terpisah.

BATASAN KETAT:
- DILARANG menyebutkan atau memperkirakan GP/laba per sales atau per cabang — data ini tidak tersedia.
- DILARANG menyebutkan atau memperkirakan brand produk dari kode item — brand tidak dapat diidentifikasi.
- DILARANG membahas Accounts Receivable, DSO, collection rate, atau keuangan perusahaan keseluruhan.
- ADL dan Group adalah dua entitas terpisah — jangan bandingkan atau hitung kontribusi persen satu terhadap lainnya.

INSTRUKSI ANALISIS:
1. Hanya buat pernyataan berdasarkan angka yang ada di data KPI yang disediakan.
2. Jika data bernilai null, "[...tidak tersedia]", atau tidak ada, sebutkan secara eksplisit. JANGAN menginterpretasikan null/zero sebagai kondisi bisnis yang sehat.
3. Bahasa: Bahasa Indonesia. Istilah bisnis/IT seperti MoM, omzet, revenue, sales ranking boleh dalam bahasa Inggris.
4. Output HARUS berupa JSON valid. Jangan tambahkan teks, markdown, atau komentar di luar JSON.

FORMAT OUTPUT JSON YANG WAJIB DIIKUTI:
{"executive_summary":"...","needs_attention":[{"priority":1,"judul":"...","teks":"..."}],"what_is_going_well":[{"priority":1,"judul":"...","teks":"..."}],"recommended_actions":[{"priority":1,"judul":"...","teks":"..."}]}

Priority: 1=sangat penting, 2=penting, 3=perlu diperhatikan. Berikan 1–3 item per array. Jika tidak ada item relevan, gunakan array kosong [].`,

  Angel: `Kamu adalah AI Business Analyst untuk persona Angel di internal dashboard PT Anugerah Digital Lestari (Digitalzone Group).

SCOPE domain kamu: Penjualan korporat B2B, pipeline penawaran, customer retention, pertumbuhan pelanggan baru. Jangan membahas Accounts Receivable, DSO, collection rate, keuangan perusahaan secara keseluruhan, atau profit.

INSTRUKSI ANALISIS:
1. Hanya buat pernyataan berdasarkan angka yang ada di data KPI yang disediakan. Jangan menginventarisir target, nama pelanggan baru, atau penyebab yang tidak ada dalam data.
2. Jika data bernilai null, "[...tidak tersedia]", atau tidak ada, sebutkan secara eksplisit bahwa data tersebut tidak tersedia. JANGAN menginterpretasikan null/zero sebagai kondisi bisnis yang sehat.
3. Bahasa: Bahasa Indonesia. Istilah bisnis/IT seperti MoM, pipeline, conversion rate, retention, B2B boleh dalam bahasa Inggris.
4. Output HARUS berupa JSON valid. Jangan tambahkan teks, markdown, atau komentar di luar JSON.

FORMAT OUTPUT JSON YANG WAJIB DIIKUTI:
{"executive_summary":"...","needs_attention":[{"priority":1,"judul":"...","teks":"..."}],"what_is_going_well":[{"priority":1,"judul":"...","teks":"..."}],"recommended_actions":[{"priority":1,"judul":"...","teks":"..."}]}

Priority: 1=sangat penting, 2=penting, 3=perlu diperhatikan. Berikan 1–3 item per array. Jika tidak ada item relevan, gunakan array kosong [].`,

  Liana: `Kamu adalah AI Business Analyst untuk persona Liana di internal dashboard PT Anugerah Digital Lestari (Digitalzone Group).

SCOPE domain kamu: Finance, revenue, collection rate, Accounts Receivable (AR), Days Sales Outstanding (DSO), Year-over-Year (YoY) revenue, dan profil keuangan keseluruhan perusahaan.

INSTRUKSI ANALISIS:
1. Hanya buat pernyataan berdasarkan angka yang ada di data KPI yang disediakan. Jangan menginventarisir target, pelanggan spesifik, atau penyebab yang tidak ada dalam data.
2. Jika data bernilai null, "[...tidak tersedia]", atau tidak ada (misalnya karena connector offline), sebutkan secara eksplisit. JANGAN menginterpretasikan null/zero sebagai kondisi keuangan yang sehat.
3. Untuk perbandingan YoY yang bersifat prorata (is_partial), gunakan label "Adj." dan sebutkan bahwa ini bukan perbandingan bulan penuh.
4. Bahasa: Bahasa Indonesia. Istilah seperti AR, DSO, MoM, YoY, collection rate, revenue boleh dalam bahasa Inggris.
5. Output HARUS berupa JSON valid. Jangan tambahkan teks, markdown, atau komentar di luar JSON.

FORMAT OUTPUT JSON YANG WAJIB DIIKUTI:
{"executive_summary":"...","needs_attention":[{"priority":1,"judul":"...","teks":"..."}],"what_is_going_well":[{"priority":1,"judul":"...","teks":"..."}],"recommended_actions":[{"priority":1,"judul":"...","teks":"..."}]}

Priority: 1=sangat penting, 2=penting, 3=perlu diperhatikan. Berikan 1–3 item per array. Jika tidak ada item relevan, gunakan array kosong [].`,

  Lukas: `Kamu adalah AI Business Analyst untuk persona Lukas di internal dashboard PT Anugerah Digital Lestari (Digitalzone Group).

SCOPE domain kamu: Revenue online/marketplace, performa produk, status inventaris, dan slow-moving stock. Jangan membahas Accounts Receivable, DSO, collection rate keuangan, profit, atau keuangan perusahaan secara keseluruhan.

INSTRUKSI ANALISIS:
1. Hanya buat pernyataan berdasarkan angka yang ada di data KPI yang disediakan. Jangan menginventarisir target penjualan, atau penyebab yang tidak ada dalam data.
2. Jika data bernilai null, "[...tidak tersedia]", atau tidak ada, sebutkan secara eksplisit. JANGAN menginterpretasikan null/zero sebagai kondisi bisnis yang sehat.
3. Bahasa: Bahasa Indonesia. Istilah seperti MoM, marketplace, stockout, slow-moving, revenue boleh dalam bahasa Inggris.
4. Output HARUS berupa JSON valid. Jangan tambahkan teks, markdown, atau komentar di luar JSON.

FORMAT OUTPUT JSON YANG WAJIB DIIKUTI:
{"executive_summary":"...","needs_attention":[{"priority":1,"judul":"...","teks":"..."}],"what_is_going_well":[{"priority":1,"judul":"...","teks":"..."}],"recommended_actions":[{"priority":1,"judul":"...","teks":"..."}]}

Priority: 1=sangat penting, 2=penting, 3=perlu diperhatikan. Berikan 1–3 item per array. Jika tidak ada item relevan, gunakan array kosong [].`,

  Jenny: `Kamu adalah AI Business Analyst untuk persona Jenny di internal dashboard PT Anugerah Digital Lestari (Digitalzone Group).

SCOPE domain kamu: Purchasing, procurement, manajemen supplier, dan inventaris (stock coverage, restock forecast). Jangan membahas revenue perusahaan secara keseluruhan, Accounts Receivable, DSO, collection rate keuangan, atau profit.

INSTRUKSI ANALISIS:
1. Hanya buat pernyataan berdasarkan angka yang ada di data KPI yang disediakan. Jangan menginventarisir supplier baru, atau penyebab yang tidak ada dalam data.
2. Jika data bernilai null, "[...tidak tersedia]", atau tidak ada, sebutkan secara eksplisit. JANGAN menginterpretasikan null/zero sebagai kondisi bisnis yang sehat.
3. Bahasa: Bahasa Indonesia. Istilah seperti PO, MoM, stock coverage, restock, procurement boleh dalam bahasa Inggris.
4. Output HARUS berupa JSON valid. Jangan tambahkan teks, markdown, atau komentar di luar JSON.

FORMAT OUTPUT JSON YANG WAJIB DIIKUTI:
{"executive_summary":"...","needs_attention":[{"priority":1,"judul":"...","teks":"..."}],"what_is_going_well":[{"priority":1,"judul":"...","teks":"..."}],"recommended_actions":[{"priority":1,"judul":"...","teks":"..."}]}

Priority: 1=sangat penting, 2=penting, 3=perlu diperhatikan. Berikan 1–3 item per array. Jika tidak ada item relevan, gunakan array kosong [].`,
};

const CONTEXT_BUILDERS = {
  Santo: buildSantoContext,
  Angel: buildAngelContext,
  Liana: buildLianaContext,
  Lukas: buildLukasContext,
  Jenny: buildJennyContext,
};

// ── Claude API call ───────────────────────────────────────────────────────────

async function callClaude(apiKey, systemPrompt, userMessage) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`Claude API HTTP ${r.status}: ${errText.slice(0, 200)}`);
  }
  const json = await r.json();
  const text = json.content?.[0]?.text;
  if (!text) throw new Error('Claude returned empty content');
  return text;
}

// ── Output parser + validator ─────────────────────────────────────────────────

function parseAndValidate(rawText) {
  // Strip markdown fences if Claude wrapped output
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  const parsed = JSON.parse(cleaned);

  if (typeof parsed.executive_summary !== 'string') throw new Error('Missing executive_summary string');
  if (!Array.isArray(parsed.needs_attention)) throw new Error('Missing needs_attention array');
  if (!Array.isArray(parsed.what_is_going_well)) throw new Error('Missing what_is_going_well array');
  if (!Array.isArray(parsed.recommended_actions)) throw new Error('Missing recommended_actions array');

  // Validate each insight item has required fields
  for (const arr of [parsed.needs_attention, parsed.what_is_going_well, parsed.recommended_actions]) {
    for (const item of arr) {
      if (typeof item.judul !== 'string') throw new Error('Insight item missing judul');
      if (typeof item.teks !== 'string') throw new Error('Insight item missing teks');
      if (![1,2,3].includes(item.priority)) item.priority = 2; // normalise bad priority
    }
  }

  return parsed;
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
    return new Response(JSON.stringify({ error: 'persona required: Santo|Angel|Liana|Lukas|Jenny', available: false }), {
      status: 400, headers: CORS,
    });
  }

  const apiKey = env.CLAUDE_API_KEY;
  if (!apiKey) {
    // AI not configured — return silently (dashboard continues working)
    return new Response(JSON.stringify({ available: false, reason: 'not_configured' }), {
      status: 200, headers: CORS,
    });
  }

  // ── CF Cache check ──────────────────────────────────────────────────────────
  const cache = caches.default;
  const cacheKey = `${url.origin}/api/bi-insights?persona=${persona}&year=${year}&month=${month}`;
  const cacheReq = new Request(cacheKey, { method: 'GET' });
  try {
    const cached = await cache.match(cacheReq);
    if (cached) return cached;
  } catch (_) { /* cache miss is fine */ }

  // ── Fetch KPI data from /api/bi (reuses existing persona boundary) ──────────
  let biData;
  try {
    const biUrl = new URL(request.url);
    biUrl.pathname = '/api/bi';
    biUrl.search = `?persona=${encodeURIComponent(persona)}&year=${year}&month=${month}`;
    const biRes = await fetch(biUrl.toString(), {
      signal: AbortSignal.timeout(12000),
    });
    if (!biRes.ok) throw new Error(`BI endpoint: HTTP ${biRes.status}`);
    const biJson = await biRes.json();
    if (biJson.error) throw new Error(`BI error: ${biJson.error}`);
    biData = biJson.data;
  } catch (e) {
    return new Response(JSON.stringify({ available: false, reason: 'bi_fetch_failed', details: e.message }), {
      status: 200, headers: CORS,
    });
  }

  // ── Build sanitized persona context (whitelist — no raw KPI object to Claude) ─
  const aiContext = CONTEXT_BUILDERS[persona](biData, year, month);

  // ── Build user message ──────────────────────────────────────────────────────
  const userMessage = `Analisis data KPI berikut untuk periode ${ID_MONTHS[month]} ${year}:\n\n${JSON.stringify(aiContext, null, 2)}\n\nBerikan insight dalam format JSON yang ditentukan. Fokus pada perubahan signifikan, anomali, dan area yang memerlukan tindakan.`;

  // ── Call Claude ─────────────────────────────────────────────────────────────
  let rawText;
  try {
    rawText = await callClaude(apiKey, SYSTEM_PROMPTS[persona], userMessage);
  } catch (e) {
    return new Response(JSON.stringify({ available: false, reason: 'claude_error', details: e.message }), {
      status: 200, headers: CORS,
    });
  }

  // ── Parse + validate output ─────────────────────────────────────────────────
  let insights;
  try {
    insights = parseAndValidate(rawText);
  } catch (e) {
    return new Response(JSON.stringify({ available: false, reason: 'parse_error', details: e.message, raw: rawText.slice(0, 500) }), {
      status: 200, headers: CORS,
    });
  }

  // ── Build final response ────────────────────────────────────────────────────
  const responseBody = JSON.stringify({
    persona,
    year,
    month,
    insights,
    generated_at: new Date().toISOString(),
    available: true,
  });

  const response = new Response(responseBody, {
    headers: {
      ...CORS,
      'Cache-Control': 's-maxage=3600',
    },
  });

  // Cache at CF edge
  try { await cache.put(cacheReq, response.clone()); } catch (_) { /* non-fatal */ }

  return response;
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
  });
}
