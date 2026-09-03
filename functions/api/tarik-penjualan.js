// CF Pages Function — proxy ke connector /api/tarik-penjualan
// POST /api/tarik-penjualan
// Connector yang call GAS server-side (tidak kena CORS / Google login redirect)

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export async function onRequestPost(context) {
  const { env } = context;
  const connUrl = env.CONNECTOR_URL || '';
  const connKey = env.CONNECTOR_API_KEY || '';

  if (!connUrl) {
    return new Response(JSON.stringify({ ok: false, error: 'CONNECTOR_URL not configured' }), { headers: CORS });
  }

  const resp = await fetch(`${connUrl}/api/tarik-penjualan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': connKey },
    body: JSON.stringify({ secret: 'dzone-internal-webhook-2026', action: 'tarikPenjualanKemarin' }),
    signal: AbortSignal.timeout(180000),
  }).catch(e => null);

  if (!resp) {
    return new Response(JSON.stringify({ ok: false, error: 'Connector tidak bisa dihubungi' }), { headers: CORS });
  }

  const text = await resp.text().catch(() => '');
  try {
    const data = JSON.parse(text);
    return new Response(JSON.stringify(data), { headers: CORS });
  } catch {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Response bukan JSON dari connector',
      status: resp.status,
      preview: text.slice(0, 300),
    }), { headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' },
  });
}
