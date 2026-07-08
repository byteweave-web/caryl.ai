// lib/ratelimit.js
// ------------------------------------------------------------------
// Token-bucket rate limiter + global cooldown + "unusual traffic" detector.
//
// Why this exists: Google Gemini's anti-abuse layer flags traffic that
// looks bot-like and IP-blocks the client with the page the user reported
//
//   "Our systems have detected unusual traffic from your computer network.
//    Please try your request again later. This traffic may have been sent
//    by malicious software, a browser plug-in, or a script that sends
//    automated requests."
//
// Three things trigger that page in practice:
//
//   1. No User-Agent (or the default `node` UA from fetch), making each
//      request look like a Unix daemon instead of a real desktop app.
//   2. Burst patterns: many requests fired within ~1s by the swarm's
//      `dispatchWithCritic` retry loop (up to 3 retries per failure;
//      up to 4 calls per dispatch in the worst case).
//   3. Retry storms on 429: every 429 schedules another Critic → another
//      Gemini call, which can ALSO 429 → Google tightens the IP block.
//
// What this module does:
//
//   - Tracks one TokenBucket per host (e.g. `generativelanguage.googleapis.com`).
//   - Lets `lib/providers.js` await a token before each fetch so burst
//     patterns are flattened into a steady RPM pulse.
//   - Sets a global "cooldown" timestamp on a host when a response is
//     429 OR contains the unusual-traffic message; `gateRequest` then
//     refuses to fetch at all until the cooldown expires.
//   - Exposes `isUnusualTraffic(body)` so callers can pick the right
//     cooldown length (90s for the page-block, 30s for plain 429).
//
// The bucket math is deliberately conservative: defaults are 30 RPM
// per host (Gemini free tier is 60 RPM, we stay under to leave headroom)
// and 30s cooldown on 429, 90s on the full anti-abuse page.
//
// Safe to call before any external service is reachable. The bucket uses
// Date.now() and is process-local; restarting the app resets everything.
// ------------------------------------------------------------------

'use strict';

// Tokens fill at `rate` per minute, up to a maximum of `burst` tokens.
class TokenBucket {
  constructor(ratePerMin, burst) {
    this.rate = Math.max(0, Number(ratePerMin) || 0);    // tokens added per minute
    // Honorary capacity. If caller passes an explicit burst, honor it
    // (even below rate — useful for "I want 3 burst then deny everything"
    // tests/scripts). If burst is omitted/0, fall back to `rate` so a fresh
    // bucket can fire the full minute worth of requests in one pulse.
    this.burst = (Number(burst) > 0) ? Number(burst) : Math.max(1, this.rate);
    this.tokens = this.burst;
    this.lastRefill = Date.now();
  }
  _refill() {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    if (elapsedMs <= 0) return;
    const refill = (elapsedMs / 60000) * this.rate;
    if (refill > 0) {
      this.tokens = Math.min(this.burst, this.tokens + refill);
      this.lastRefill = now;
    }
  }
  tryConsume(n) {
    n = Number.isFinite(n) ? n : 1;
    this._refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return { ok: true, tokens: this.tokens };
    }
    const need = n - this.tokens;
    const waitMs = (need / this.rate) * 60000;
    return { ok: false, tokens: this.tokens, waitMs: waitMs };
  }
  // Resolve when a token is available. Capped wait so a misconfigured
  // bucket (rate=0) can't hang the event loop forever.
  async consumeAsync(n) {
    const maxIters = 4000;
    for (let i = 0; i < maxIters; i++) {
      const r = this.tryConsume(n);
      if (r.ok) return r;
      const wait = Math.max(20, Math.min(r.waitMs || 100, 250));
      await new Promise((rs) => setTimeout(rs, wait));
    }
    const err = new Error('ratelimit: timed out waiting for token after ' + maxIters + ' polls');
    err.code = 'RATELIMIT_TIMEOUT';
    throw err;
  }
}

// host -> { bucket, cooldownUntilMs, lastErrorAt, lastErrorBody, lastErrorStatus }
const _BUCKETS = Object.create(null);

function _hostOf(baseUrl) {
  try { return new URL(String(baseUrl)).host; } catch (_e) { return String(baseUrl); }
}

function getBucket(host, opts) {
  opts = opts || {};
  const key = host || 'default';
  if (!_BUCKETS[key]) {
    _BUCKETS[key] = {
      bucket: new TokenBucket(
        Number.isFinite(opts.ratePerMin) ? opts.ratePerMin : 30,
        Number.isFinite(opts.burst) ? opts.burst : 30
      ),
      cooldownUntilMs: 0,
      lastErrorAt: 0,
      lastErrorBody: '',
      lastErrorStatus: 0,
    };
  }
  return _BUCKETS[key];
}

function gateRequest(host, opts) {
  const e = getBucket(host, opts);
  if (Date.now() < e.cooldownUntilMs) {
    const remain = e.cooldownUntilMs - Date.now();
    const err = new Error('cool-down for ' + host + ' (' + Math.ceil(remain / 1000) + 's left)');
    err.code = 'COOLDOWN';
    err.host = host;
    err.cooldownRemainingMs = remain;
    throw err;
  }
  return e;
}

function isInCooldown(host) {
  const e = _BUCKETS[host || 'default'];
  return !!(e && Date.now() < e.cooldownUntilMs);
}

function cooldownRemainingMs(host) {
  const e = _BUCKETS[host || 'default'];
  if (!e) return 0;
  return Math.max(0, e.cooldownUntilMs - Date.now());
}

function triggerCooldown(host, ms, reason) {
  const e = getBucket(host);
  e.lastErrorAt = Date.now();
  e.lastErrorBody = String(reason || '');
  if (!Number.isFinite(ms) || ms <= 0) {
    // Explicit clear (negative or zero ms → instant expiry). Used by tests AND
    // by managers that want to forcibly drop the cool-down without waiting.
    e.cooldownUntilMs = 0;
    return 0;
  }
  // Monotonic: a longer forthcoming cool-down overrides a shorter one in
  // flight, but a shorter call cannot shorten an active cool-down. This
  // matches the typical backoff pattern where the *first* hit is the
  // shortest and any subsequent hit only ever grows the wait.
  const target = Date.now() + ms;
  if (target > e.cooldownUntilMs) e.cooldownUntilMs = target;
  try { console.warn('[ratelimit]', host, 'cooldown', ms + 'ms', reason || ''); } catch (_) {}
  return e.cooldownUntilMs;
}

function recordError(host, status, body) {
  const e = getBucket(host);
  e.lastErrorAt = Date.now();
  e.lastErrorStatus = Number(status) || 0;
  e.lastErrorBody = String(body || '').slice(0, 512);
  return e;
}

// True if a response body looks like Google's automated-traffic page.
// The body may arrive as a string OR a { error: { message } } object OR
// the full JSON envelope — we stringify and test all three layers.
const _UNUSUAL_TRAFFIC_PATTERNS = [
  /unusual traffic/i,
  /automated requests/i,
  /detected requests coming from your computer/i,
  /in violation of the terms of service/i,
  /please try your request again later/i,
  /different computer using the same ip address/i,
];
function isUnusualTraffic(body) {
  let s = '';
  if (typeof body === 'string') s = body;
  else if (body && typeof body === 'object') {
    try {
      s = JSON.stringify(body);
      if (body.error && body.error.message) s += ' ' + body.error.message;
      if (body.message) s += ' ' + body.message;
    } catch (_e) { s = String(body); }
  } else s = String(body);
  return _UNUSUAL_TRAFFIC_PATTERNS.some(function (rx) { return rx.test(s); });
}

// For tests: forget all bucket state.
function resetForTests() {
  for (const k of Object.keys(_BUCKETS)) delete _BUCKETS[k];
}

module.exports = {
  TokenBucket,
  getBucket,
  gateRequest,
  isInCooldown,
  cooldownRemainingMs,
  triggerCooldown,
  recordError,
  isUnusualTraffic,
  _hostOf,
  resetForTests,
  _UNUSUAL_TRAFFIC_PATTERNS: undefined,  // not exported (private); tests should use isUnusualTraffic
};
