// CF Pages Function — issue JWT for DZ Document Archive access
// POST /api/doc-archive-auth
// Body: { user: "TC LUVI", password: "...", ts: 1730000000000 }
//
// Security model:
// - `password` is sent over HTTPS (TLS-protected); never stored plaintext in CF env.
// - CF function hashes password server-side: SHA-256(user + ":" + password + ":doc-archive-2026")
// - Compared against DOC_ARCHIVE_PASS_MAP (pre-computed hashes, not raw passwords).
// - `ts` is a client Unix ms timestamp; rejected if |ts - serverNow| > 5 min.
//   This bounds replay of a captured HTTPS request to 5 minutes.
// - JWT issued for 8 hours, signed HS256 with DOC_ARCHIVE_JWT_SECRET.
//
// Architectural note: passwords also exist in USER_ACCOUNTS in index.html (needed for
// the app's login screen). This CF function adds a second server-side verification
// layer — a JWT cannot be obtained without both network access to the app AND knowing
// the correct password. This is the appropriate security level for this internal tool.
//
// CF env secrets required:
//   DOC_ARCHIVE_JWT_SECRET   — random ≥32-char string
//   DOC_ARCHIVE_PASS_MAP     — JSON: { "UserName": "sha256hex", ... }
//
// To regenerate a hash entry after a password change:
//   node -e "const c=require('crypto');console.log(c.createHash('sha256').update('NAME:PASS:doc-archive-2026').digest('hex'))"

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const MAX_TS_DRIFT_MS = 5 * 60 * 1000; // 5 minutes

function b64url(s) {
  return btoa(s).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

async function jwtSign(payload, secret) {
  const header = b64url(JSON.stringify({ alg:'HS256', typ:'JWT' }));
  const body   = b64url(JSON.stringify(payload));
  const msg    = `${header}.${body}`;
  const key    = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name:'HMAC', hash:'SHA-256' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  const sig    = b64url(String.fromCharCode(...new Uint8Array(sigBuf)));
  return `${msg}.${sig}`;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function jsonErr(msg, status) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); }
  catch (_) { return jsonErr('Body harus JSON.', 400); }

  const { user, password, ts } = body || {};

  // Validate presence and types
  if (!user || typeof user !== 'string') return jsonErr('Field user wajib diisi.', 400);
  if (!password || typeof password !== 'string') return jsonErr('Field password wajib diisi.', 400);
  if (typeof ts !== 'number') return jsonErr('Field ts wajib diisi (unix ms).', 400);

  // Reject if timestamp drift > 5 minutes (prevents replay of captured HTTPS requests)
  const serverNow = Date.now();
  if (Math.abs(serverNow - ts) > MAX_TS_DRIFT_MS) {
    return jsonErr('Request kedaluwarsa. Coba lagi.', 401);
  }

  // Load CF env vars
  const passMapRaw = env.DOC_ARCHIVE_PASS_MAP || '';
  if (!passMapRaw) return jsonErr('DOC_ARCHIVE_PASS_MAP belum dikonfigurasi.', 503);
  const jwtSecret = env.DOC_ARCHIVE_JWT_SECRET || '';
  if (!jwtSecret) return jsonErr('DOC_ARCHIVE_JWT_SECRET belum dikonfigurasi.', 503);

  let passMap;
  try { passMap = JSON.parse(passMapRaw); }
  catch (_) { return jsonErr('DOC_ARCHIVE_PASS_MAP format tidak valid.', 503); }

  const userName = user.trim();
  const expectedHash = passMap[userName];
  if (!expectedHash || typeof expectedHash !== 'string') {
    // Not in map = not authorized (default DENY — same response as wrong password to prevent user enumeration)
    return jsonErr('Nama atau password salah.', 403);
  }

  // Hash password server-side: SHA-256(user + ":" + password + ":doc-archive-2026")
  // `password` never stored; `expectedHash` is the pre-computed hash stored in CF env (not plaintext)
  const actualHash = await sha256Hex(userName + ':' + password + ':doc-archive-2026');

  if (!constantTimeEqual(actualHash, expectedHash)) {
    return jsonErr('Nama atau password salah.', 403);
  }

  // All checks passed — issue 8-hour JWT
  const now = Math.floor(Date.now() / 1000);
  const token = await jwtSign({ sub: userName, iat: now, exp: now + 8 * 3600 }, jwtSecret);
  return new Response(JSON.stringify({ token }), { headers: CORS_HEADERS });
}

export async function onRequestOptions() {
  return new Response(null, { headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}
