// ====================================================================
// lib/respond.js — Vercel response helpers.
//
// Uses res.send(JSON.stringify(...)) instead of res.json() because the
// latter has been unreliable for early-return paths in our prior Vercel
// projects (Outbound Flywheel). Always set Content-Type explicitly
// BEFORE any logic runs.
// ====================================================================

const crypto = require('crypto');

function setJsonHeaders(res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
}

function ok(res, payload = { ok: true }) {
  setJsonHeaders(res);
  res.statusCode = 200;
  res.send(JSON.stringify(payload));
}

function bad(res, msg, status = 400) {
  setJsonHeaders(res);
  res.statusCode = status;
  res.send(JSON.stringify({ ok: false, error: msg }));
}

function fail(res, err) {
  setJsonHeaders(res);
  res.statusCode = 500;
  const msg = err?.message || String(err);
  console.error('[bridge:fail]', msg, err?.stack);
  res.send(JSON.stringify({ ok: false, error: msg }));
}

// Fails CLOSED. An unset WEBHOOK_SHARED_SECRET used to mean "auth
// disabled", which turned a missing env var into an open write path into
// StraighterLine's Attio. Now it rejects and says why.
function verifySecret(req) {
  const required = process.env.WEBHOOK_SHARED_SECRET;
  if (!required) {
    console.error('[bridge:auth] WEBHOOK_SHARED_SECRET is not set — rejecting request');
    return false;
  }
  const provided = req.query?.secret || req.headers['x-bridge-secret'];
  if (typeof provided !== 'string') return false;
  return timingSafeEqual(provided, required);
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // crypto.timingSafeEqual throws on length mismatch, so compare lengths
  // separately and still run the constant-time compare on equal-length
  // buffers to avoid leaking content via timing.
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = { setJsonHeaders, ok, bad, fail, verifySecret };
