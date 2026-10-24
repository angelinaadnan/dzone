// Cloudflare Pages Function — Sheet Sync Trigger
// POST /api/sheet-sync → calls connector to trigger Accurate → Google Sheet sync

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

export async function onRequestPost(context) {
  const { env } = context;
  const connectorUrl = env.CONNECTOR_URL || 'https://connectoracc.dzoutlet.co.id';
  const apiKey       = env.CONNECTOR_API_KEY || '';

  try {
    const res = await fetch(connectorUrl + '/api/sheet/sync', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    return new Response(JSON.stringify(data), { headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: { ...CORS, 'Access-Control-Allow-Methods': 'POST, OPTIONS' },
  });
}
