// OpenAI-compatible chat client with SSE streaming.
// Works unchanged with Groq, Gemini (OpenAI endpoint), OpenAI, OpenRouter, and any
// compatible server - only baseUrl/model/key differ. This single interface is also how
// a future local engine would plug in.

const ratelimit = require('./ratelimit');
// `config` is the user's settings.json (lib/config.js) — we read defaults for
// the anti-abuse knobs so the user can dial them in Settings. Wrapped in
// try/catch so non-Electron contexts (plain `node tests/...`) don't crash on
// `require('electron')` — the require only fails then, so we fall back to
// compile-time defaults equivalent to lib/config.js DEFAULTS.
let _cfg = null;
try { _cfg = require('./config'); } catch (_e) { _cfg = null; }
function _cfgGet(key, fallback) {
  if (_cfg && typeof _cfg.get === 'function') {
    try { return _cfg.get()[key]; } catch (_e) { /* fall through */ }
  }
  return fallback;
}

// Default UA looks like a real desktop app — Google's anti-abuse layer
// (the "unusual traffic from your computer network" page) flags requests
// that arrive with the Node/Electron default UA as bot-like. Callers can
// override per-request via opts.userAgent (used by tests + a future custom
// routing layer).
const DEFAULT_USER_AGENT = 'Caryl-AI/1.0 (Electron Desktop)';

function joinUrl(base, suffix) {
  return String(base).replace(/\/+$/, '') + suffix;
}

async function streamChat({ baseUrl, apiKey, model, messages, temperature, tools, signal, onToken, userAgent }) {
  const host = ratelimit._hostOf(baseUrl);

  // Respect the user-level anti-abuse toggle (defaults ON). When OFF, we
  // still record 429s but don't gate subsequent calls, so power users can
  // opt out of the cooldown if they're debugging or running parallel ops.
  const antiAbuse = _cfgGet('antiAbuseEnabled', true) !== false;

  // Piggy-back the rate-limit module: WAIT for a token AND honor any
  // active cooldown BEFORE the network call. The token-bucket prevents
  // bursts; the cooldown gate handles the rare 429 / page-block.
  if (antiAbuse && ratelimit.isInCooldown(host)) {
    const remain = ratelimit.cooldownRemainingMs(host);
    const err = new Error(
      'cool-down: ' + host + ' is in a cool-down period for another ' +
      Math.ceil(remain / 1000) + 's (Gemini detected automated traffic earlier).'
    );
    err.code = 'COOLDOWN';
    err.host = host;
    err.cooldownRemainingMs = remain;
    throw err;
  }

  // Drain a token from the per-host bucket BEFORE the fetch. This is the
  // preventive side of the anti-abuse system: it stops parallel swarm
  // dispatches from firing N requests in <1s. The bucket is created
  // lazily here with the user's `geminiRpmCap` (default 30, under the
  // Gemini free-tier 60 RPM ceiling) so a sustained burst flattens to a
  // steady pulse instead of a fan-out the IP-block detector hates.
  if (antiAbuse) {
    const rpm = _cfgGet('geminiRpmCap', 30);
    if (rpm > 0) {
      const slot = ratelimit.getBucket(host, { ratePerMin: rpm, burst: rpm });
      await slot.bucket.consumeAsync(1);
    }
  }

  const body = {
    model,
    messages,
    temperature: typeof temperature === 'number' ? temperature : 0.7,
    stream: true
  };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }

  const res = await fetch(joinUrl(baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
      // Real User-Agent on EVERY outbound call. Without this, the
      // puppeteer/Node default UA is a strong signal Google's anti-abuse
      // uses to flag the request as bot-like.
      'User-Agent': userAgent || DEFAULT_USER_AGENT,
      'X-Client-Name': 'Caryl-AI',
      'X-Client-Platform': 'electron',
    },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    let detail = '';
    let bodyJson = null;
    let bodyText = '';
    try {
      bodyJson = await res.json();
      detail = (bodyJson && bodyJson.error && bodyJson.error.message) || '';
      bodyText = JSON.stringify(bodyJson);
    } catch (_e) {
      // body wasn't JSON; bodyText stays empty
    }
    if (res.status === 401) detail = detail || 'Invalid API key.';

    if (antiAbuse && (res.status === 429 || ratelimit.isUnusualTraffic(detail + ' ' + bodyText))) {
      detail = detail || 'Rate limited - slow down or check your plan.';
      // Page-block = Google's heavy anti-abuse: 90s cool-down so we don't
      // re-trip the IP block. Plain 429 = provider-level soft throttle:
      // 30s cool-down is enough. Both numbers are user-tunable in Settings.
      const unusual = ratelimit.isUnusualTraffic(detail + ' ' + bodyText);
      const cooldownMs = unusual
        ? _cfgGet('geminiUnusualTrafficCooldownMs', 90000)
        : _cfgGet('geminiSoftCooldownMs', 30000);
      ratelimit.triggerCooldown(host, cooldownMs, 'http_' + res.status + (unusual ? '_unusual_traffic' : ''));
      ratelimit.recordError(host, res.status, bodyText);
    }
    throw new Error('API ' + res.status + (detail ? ': ' + detail : ''));
  }

  // Parse the Server-Sent Events stream chunk by chunk.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls = []; // [{ id, name, arguments }] - assembled from streamed fragments


  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // keep the trailing partial line

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || !line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return { content: content, toolCalls: toolCalls };
      try {
        const json = JSON.parse(data);
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (!delta) continue;
        if (delta.content) { content += delta.content; if (onToken) onToken(delta.content); }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index || 0;
            if (!toolCalls[i]) toolCalls[i] = { id: '', name: '', arguments: '' };
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function && tc.function.name) toolCalls[i].name = tc.function.name;
            if (tc.function && tc.function.arguments) toolCalls[i].arguments += tc.function.arguments;
          }
        }
      } catch (_e) {
        // keep-alive ping or split frame - ignore and continue
      }
    }
  }
  return { content: content, toolCalls: toolCalls };
}

async function listModels({ baseUrl, apiKey, userAgent }) {
  const host = ratelimit._hostOf(baseUrl);
  const antiAbuse = _cfgGet('antiAbuseEnabled', true) !== false;
  if (antiAbuse && ratelimit.isInCooldown(host)) {
    const remain = ratelimit.cooldownRemainingMs(host);
    const err = new Error('cool-down: ' + host + ' in cool-down for ' + Math.ceil(remain / 1000) + 's');
    err.code = 'COOLDOWN';
    err.host = host;
    err.cooldownRemainingMs = remain;
    throw err;
  }
  const res = await fetch(joinUrl(baseUrl, '/models'), {
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'User-Agent': userAgent || DEFAULT_USER_AGENT,
      'X-Client-Name': 'Caryl-AI',
    }
  });
  if (!res.ok) {
    if (antiAbuse) {
      // Symmetric with streamChat: a 429 on /models means the next chat
      // call (sharing the per-host bucket) must NOT be made. Otherwise
      // Settings refresh immediately followed by a chat hit looks like a
      // 2-request burst starting in the bad window.
      const cooldownMs = _cfgGet('geminiSoftCooldownMs', 30000);
      ratelimit.triggerCooldown(host, cooldownMs, 'listmodels_http_' + res.status);
    }
    ratelimit.recordError(host, res.status, '');
    throw new Error('API ' + res.status + ': ' + res.statusText);
  }
  const json = await res.json();
  const data = (json && json.data) || [];
  return data.map((m) => m.id).filter(Boolean).sort();
}

module.exports = { streamChat, listModels, DEFAULT_USER_AGENT };
