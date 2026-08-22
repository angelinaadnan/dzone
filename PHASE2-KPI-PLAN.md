# Phase 2 BI KPI Plan — DZ Outlet Internal
**Dibuat:** 2026-08-22  
**Status Phase 1:** Deployed ke `internal.digitalzone.co.id`  
**Status Phase 2:** Planning only — DO NOT implement yet  
**Prinsip:** Target vs Actual → Growth → Trend → Alert → Action | NO AI (Phase 3)

---

## Ringkasan Phase 1 ✅

| Persona | KPI Aktif | Source | Status |
|---------|-----------|--------|--------|
| Santo | Retail Sales MTD, Orders, Branch, Attendance, Sales Performance | Supabase | ✅ Live |
| Angel | Pipeline, Konversi, B2B Revenue, New Customers, Top Customers | Supabase + Accurate | ✅ Live |
| Liana | Revenue, Collection, AR Aging, YTD, Channel Split, Top Customers, Internal Orders | Accurate + Supabase | ✅ Live |
| Lukas | Online Revenue, Stock Health, Top Items by Revenue, Slow Moving | Accurate | ✅ Live |
| Jenny | PO MTD, Top Suppliers, Service Intakes, Stock Health, Slow Moving | Supabase + Accurate | ✅ Live |

**Finance boundary:** Liana EKSKLUSIF. Santo/Angel/Lukas/Jenny TIDAK mendapat revenue/AR/collection/cashflow/profit dari connector.

---

## Keputusan Arsitektur Phase 2

- Semua KPI baru tetap hanya READ — tidak ada write ke database
- Tidak ada schema change kecuali yang eksplisit dicatat di kolom "DB Changes Needed"
- Connector (`dzone-connector`) tetap di repo terpisah
- Endpoint baru tetap di `/api/bi` dengan tambahan parameter jika perlu
- NO AI/ML features (direncanakan di Phase 3)

---

## Santo — Retail & Operations

**Phase 1 tersedia:** Retail value + count MTD, Orders by status, Branch requests, Attendance, Sales performance top-10

### KPI Phase 2

| KPI | Definisi | Formula | Source | Target | Periode | Bisa Dihitung Sekarang? | DB Change? |
|-----|---------|---------|--------|--------|---------|------------------------|------------|
| Daily Sales Trend | Nilai penjualan per hari, 14 hari terakhir | `SUM(order.value) GROUP BY date` | Supabase `orders` | Tren naik vs minggu sebelumnya | Harian | ✅ Ya — data sudah ada di `santoKPIs()` | Tidak |
| Branch Revenue MoM | Revenue per cabang vs bulan lalu | `SUM by source_branch` dibanding period sebelumnya | Supabase `orders` | Setiap cabang MoM positif | Bulanan | ✅ Ya | Tidak |
| Order Fulfillment Rate | % order terpenuhi (delivered / total aktif) | `count(status='delivered') / count(active)` | Supabase `orders` | ≥ 85% | Bulanan | ✅ Ya | Tidak |
| Average Order Value | Nilai rata-rata per order | `SUM(value) / COUNT(orders)` | Supabase `orders` | Tren naik | Bulanan | ✅ Ya | Tidak |
| Sales Target vs Actual | Pencapaian setiap sales vs target | `actual_value / target_value × 100%` | Supabase `orders` + tabel target baru | 100% achievement | Bulanan | ❌ Tidak — belum ada data target | **Ya: tabel `sales_targets(name, month, year, target_value)`** |
| Attendance Rate | Tingkat kehadiran staf | `present / total_headcount` | Supabase `attendance` | ≥ 90% | Harian | ❌ Partial — tidak ada total headcount | **Ya: config `staff_headcount` per role** |

**Quick wins (tanpa DB change):** Daily Sales Trend, Branch Revenue MoM, Fulfillment Rate, AOV  
**Butuh data baru:** Sales Target (tabel targets), Attendance Rate (headcount config)

---

## Angel — Corporate Sales & B2B

**Phase 1 tersedia:** Pipeline aktif, Conversion rate, B2B Revenue MTD, New Customers, Top Customers, Sales Conversion table

### KPI Phase 2

| KPI | Definisi | Formula | Source | Target | Periode | Bisa Dihitung Sekarang? | DB Change? |
|-----|---------|---------|--------|--------|---------|------------------------|------------|
| Pipeline Funnel Breakdown | Draft → Sent → Approved → Converted per step | `count by status` sequential | Supabase `quotations` | Konversi setiap stage naik | Bulanan | ✅ Ya — data ada, hanya perlu visualisasi | Tidak |
| Pipeline MoM Trend | Jumlah quotation baru + conversion per bulan | `count by created_month` | Supabase `quotations` | Tren naik | Bulanan | ✅ Ya | Tidak |
| B2B Revenue Trend 12 Bulan | Revenue B2B per bulan selama setahun | `channelSplit per month, channel=b2b` | Accurate connector (query baru per bulan) | Growth 5–10% MoM | Bulanan | ❌ Perlu query connector baru | Tidak (query SELECT baru di connector) |
| Customer Retention Rate | % pelanggan bulan ini yang juga beli bulan lalu | `count(repeat_buyers) / count(prior_buyers)` | Accurate connector (query baru) | ≥ 70% | Bulanan | ❌ Perlu query baru | Tidak (query SELECT baru) |
| Quotation Win Rate Trend | Conversion rate 6 bulan ke belakang | `converted / total by month` | Supabase `quotations` | Naik ke ≥ 40% | Bulanan | ✅ Ya | Tidak |
| Sales Target vs Actual (B2B) | Pencapaian converted vs target per sales | `converted_value / target` | Supabase + tabel target | 100% | Bulanan | ❌ Tidak ada data target | **Ya: tabel `quotation_targets(sales_name, month, year, target_count, target_value)`** |

**Quick wins:** Pipeline Funnel, Pipeline Trend, Win Rate Trend  
**Butuh connector query baru:** B2B Revenue Trend, Retention Rate  
**Butuh DB baru:** Sales Target

---

## Liana — Finance & Controlling

**Phase 1 tersedia:** Revenue MTD + MoM, Collection MTD + rate, AR Outstanding + aging buckets, YTD revenue + collection, Channel split, Top customers, Internal orders payment

### KPI Phase 2

| KPI | Definisi | Formula | Source | Target | Periode | Bisa Dihitung Sekarang? | DB Change? |
|-----|---------|---------|--------|--------|---------|------------------------|------------|
| Revenue 12-Bulan Trend | Grafik revenue per bulan setahun penuh | `revenueByMonth` (sudah ada di connector) | Accurate connector | YoY growth | Bulanan | ✅ Ya — data dan query sudah ada, tinggal expose ke UI | Tidak |
| Collection Rate Trend | Collection rate (%) per bulan 6 bulan terakhir | `collected / invoiced per month` | Accurate connector (query baru) | ≥ 85% stabil | Bulanan | ❌ Perlu query monthly collection | Tidak (query SELECT baru) |
| AR Alert | Alert jika invoice overdue >90h melewati threshold | `count(ar_over_90d) > N` | Accurate connector | < 5 invoice >90 hari | Harian | ✅ Ya — field sudah ada di lianaKPIs AR | Tidak |
| DSO (Days Sales Outstanding) | Rata-rata hari piutang tertagih | `AR_total / (Revenue_MTD / days_in_month)` | Accurate connector | ≤ 45 hari | Bulanan | ✅ Ya — bisa dihitung dari data existing | Tidak |
| Gross Revenue Growth YoY | Revenue bulan ini vs bulan sama tahun lalu | `(rev_this_year - rev_last_year) / rev_last_year` | Accurate connector (perlu query lintas tahun) | +10% YoY | Bulanan | ❌ Perlu query tahun sebelumnya | Tidak (query SELECT baru) |
| Gross Margin | (Revenue - COGS) / Revenue | Butuh data biaya/HPP | Accurate (modul pengeluaran — belum di-sync) | ≥ 20% | Bulanan | ❌ COGS/expense tidak tersedia di DB | **Ya: perlu sync modul expense/purchase dari Accurate** |
| Operating Expense Ratio | Total opex / revenue | Butuh data expense | Accurate expense module | ≤ 70% | Bulanan | ❌ Expense tidak di-sync | **Ya: perlu sync expense Accurate** |

**Quick wins (data sudah ada):** Revenue 12-Bulan Trend, AR Alert, DSO  
**Butuh query baru di connector:** Collection Rate Trend, YoY Growth  
**Butuh sync data baru dari Accurate:** Gross Margin, Opex Ratio (scope besar, pertimbangkan Phase 3)

---

## Lukas — Product & Online Marketplace

**Phase 1 tersedia:** Online/Marketplace Revenue MTD, Stock Health (stockout/critical/low count), Top Items by Revenue, Slow Moving Items

### KPI Phase 2

| KPI | Definisi | Formula | Source | Target | Periode | Bisa Dihitung Sekarang? | DB Change? |
|-----|---------|---------|--------|--------|---------|------------------------|------------|
| Top Items by Qty | Item terlaris berdasarkan unit terjual | `topItemsByQty` (sudah ada di connector) | Accurate connector | — | Bulanan | ✅ Ya — connector sudah punya query, CF + UI tinggal expose | Tidak |
| Online Revenue Trend 12 Bulan | Revenue marketplace per bulan setahun | `channelSplit by month, channel=marketplace` | Accurate connector (query baru) | Growth 5–10% MoM | Bulanan | ❌ Perlu query per-bulan per-channel | Tidak (query SELECT baru) |
| Stockout Alert Count Trend | Tren jumlah stockout per minggu | Perlu snapshot stok periodik | Accurate connector | Tren turun | Mingguan | ❌ Stock snapshot tidak disimpan — hanya current state | **Ya: perlu tabel `stock_snapshots` (scheduled daily/weekly)** |
| Item Sell-Through Rate | % stok terjual vs total stok tersedia | `sold_qty / (opening_stock + received)` | Accurate — butuh data movement | ≥ 60% | Bulanan | ❌ Tidak ada inventory movement history | **Ya: perlu inventory log dari Accurate** |
| Category Revenue Breakdown | Revenue per kategori produk | `GROUP BY category` | Accurate — butuh mapping kategori | — | Bulanan | ❌ Tergantung field kategori di item Accurate | Cek field kategori di Accurate items |
| Item Gross Margin | Margin per item (revenue - cost) | Butuh harga beli item | Accurate (jika purchase price di-sync) | ≥ 20% margin per item | Bulanan | ❌ Item cost price belum di-sync | **Ya: perlu sync purchase price dari Accurate** |

**Quick wins:** Top Items by Qty (hanya expose dari connector yang sudah ada)  
**Butuh query baru:** Online Revenue Trend, Category Breakdown  
**Butuh data/infra baru:** Stockout Trend (snapshot table), Sell-Through (movement log), Item Margin (cost sync)

---

## Jenny — Purchasing & Procurement

**Phase 1 tersedia:** PO count + value MTD + MoM, PO by status, PO pending, Top Suppliers, Service Intakes, Stock Health, Slow Moving Items

### KPI Phase 2

| KPI | Definisi | Formula | Source | Target | Periode | Bisa Dihitung Sekarang? | DB Change? |
|-----|---------|---------|--------|--------|---------|------------------------|------------|
| Top Items by Qty (untuk keputusan restock) | Item dengan demand tertinggi by unit | `topItemsByQty` (connector sudah punya) | Accurate connector | — | Bulanan | ✅ Ya — CF `jennyKPIs()` tinggal expose dari connector | Tidak |
| PO Lead Time | Rata-rata hari dari PO dibuat ke selesai | `AVG(completed_at - created_at) WHERE status=completed` | Supabase `purchase_orders` | ≤ 14 hari | Bulanan | ✅ Ya — jika field `completed_at` ada | Cek: apakah `purchase_orders` punya `completed_at`? |
| Restock Forecast Alert | Item yang akan stockout dalam 30 hari | `available_stock / avg_daily_sales` | Accurate connector (query baru) | 0 sudden stockout | Mingguan | ❌ Perlu query avg sales velocity per item | Tidak (query SELECT baru) |
| Supplier On-Time Rate | % PO selesai tepat waktu | `count(on_time) / count(completed)` | Supabase `purchase_orders` | ≥ 80% | Bulanan | ❌ Tidak ada `due_date` di PO | **Ya: tambah kolom `due_date` di `purchase_orders`** |
| Supplier Spend MoM | Total spend per supplier per bulan | `SUM(po_value) GROUP BY supplier, month` | Supabase `purchase_orders` | Diversifikasi — tidak ada satu supplier > 50% | Bulanan | ✅ Ya | Tidak |
| Stock Coverage Days | Berapa hari stok cukup berdasarkan avg penjualan | `available_stock / avg_daily_sales` | Accurate connector (query baru) | ≥ 30 hari coverage | Mingguan | ❌ Perlu sales velocity per item | Tidak (query SELECT baru) |

**Quick wins:** Top Items by Qty, Supplier Spend MoM, PO Lead Time (jika field ada)  
**Butuh query baru di connector:** Restock Forecast, Stock Coverage Days  
**Butuh DB change:** Supplier On-Time Rate (tambah `due_date` di purchase_orders)

---

## Prioritas Implementasi Phase 2

### Tier 1 — Quick Wins (data sudah ada, hanya perlu expose/query kecil)

| # | KPI | Persona | Effort |
|---|-----|---------|--------|
| 1 | Revenue 12-Bulan Trend | Liana | Kecil — query `revenueByMonth` sudah ada di connector |
| 2 | DSO Calculation | Liana | Kecil — hitung dari AR + Revenue yang sudah ada |
| 3 | AR Alert Threshold | Liana | Kecil — field AR sudah ada, tambah logic alert |
| 4 | Top Items by Qty | Lukas | Kecil — connector sudah punya, CF whitelist + UI |
| 5 | Top Items by Qty (restock signal) | Jenny | Kecil — same connector query |
| 6 | Pipeline Funnel Breakdown | Angel | Kecil — Supabase data ada, UI perlu funnel view |
| 7 | Supplier Spend MoM | Jenny | Kecil — aggregate dari Supabase purchase_orders |
| 8 | Order Fulfillment Rate | Santo | Kecil — hitung dari orders by status |

### Tier 2 — Butuh Connector Query Baru (SELECT only, no schema change)

| # | KPI | Persona | Effort |
|---|-----|---------|--------|
| 9 | B2B Revenue Trend 12 Bulan | Angel | Sedang — query channelSplit per bulan |
| 10 | Customer Retention Rate | Angel | Sedang — query customer overlap dua periode |
| 11 | Collection Rate Trend | Liana | Sedang — monthly payment summary |
| 12 | Online Revenue Trend | Lukas | Sedang — monthly marketplace channelSplit |
| 13 | Restock Forecast Alert | Jenny | Sedang — avg sales velocity per item |
| 14 | Stock Coverage Days | Jenny | Sedang — avg daily sales per item |
| 15 | YoY Revenue Growth | Liana | Sedang — query prior year |

### Tier 3 — Butuh Database/Schema Change

| # | KPI | Persona | DB Change Required |
|---|-----|---------|-------------------|
| 16 | Sales Target vs Actual | Santo, Angel | Tabel `sales_targets` + `quotation_targets` |
| 17 | Supplier On-Time Rate | Jenny | Kolom `due_date` di `purchase_orders` |
| 18 | Attendance Rate | Santo | Config `staff_headcount` per role |
| 19 | Stockout Trend | Lukas | Tabel `stock_snapshots` (scheduled daily) |

### Tier 4 — Butuh Sumber Data Baru dari Accurate (scope besar)

| # | KPI | Persona | Data Baru |
|---|-----|---------|-----------|
| 20 | Gross Margin | Liana | Sync modul expense/HPP dari Accurate |
| 21 | Operating Expense Ratio | Liana | Sync expense Accurate |
| 22 | Item Gross Margin | Lukas | Sync purchase price dari Accurate |
| 23 | Sell-Through Rate | Lukas | Sync inventory movement log dari Accurate |

---

## Keputusan yang Perlu Diambil (Business)

1. **Sales Target per bulan** — apakah ada data target penjualan per sales? Perlu diinput manual atau ada sistem target?
2. **Accurate Expense Module** — apakah modul pengeluaran Accurate sudah digunakan? Perlu diputuskan untuk sync ke database.
3. **Stockout Snapshot Frequency** — untuk Lukas, trend stockout perlu scheduled job. Berapa sering: harian atau mingguan?
4. **Supplier Due Date** — apakah purchase order di Supabase sudah punya atau bisa ditambah due_date?
5. **KPI Alert Threshold** — berapa batas acceptable untuk AR >90 hari? Berapa target conversion rate Angel?

---

## Keputusan yang Sudah Diambil (Technical)

- Phase 2 = implementasi KPI baru saja. NO AI, NO ML.
- Finance data (revenue, AR, cashflow) tetap EKSKLUSIF untuk Liana.
- Connector tetap di repo terpisah `angelinaadnan/dzone-connector`.
- Semua query tetap SELECT-only.
- Phase 3 = AI/Alert automation (direncanakan setelah Phase 2 stabil).
