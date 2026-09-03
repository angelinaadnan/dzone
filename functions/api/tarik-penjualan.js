// CF Pages Function — proxy ke Google Apps Script webhook
// POST /api/tarik-penjualan
// Menghindari CORS block saat browser langsung hit script.google.com

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const GAS_URL = 'https://script.google.com/macros/s/AKfycbw0AOxdmS_50l-kX8VT0ZhZRkZ95wpyVgPE8ZFuxlttRV_5BSWrE7BaLmSKgot8DErvaw/exec';

export async function onRequestPost(context) {
  const body = await context.request.json().catch(() => ({}));

  const resp = await fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  }).catch(e => null);

  if (!resp) {
    return new Response(JSON.stringify({ ok: false, error: 'GAS tidak bisa dihubungi' }), { headers: CORS });
  }

  const text = await resp.text().catch(() => '');
  try {
    const data = JSON.parse(text);
    return new Response(JSON.stringify(data), { headers: CORS });
  } catch {
    // GAS returned non-JSON (HTML redirect / error) — return raw for debugging
    return new Response(JSON.stringify({
      ok: false,
      error: 'GAS return bukan JSON',
      status: resp.status,
      preview: text.slice(0, 500),
    }), { headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' },
  });
}
