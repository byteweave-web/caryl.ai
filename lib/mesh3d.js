// lib/mesh3d.js
// ------------------------------------------------------------------
// Pure HTTP adapter for 3D generation providers (Meshy.ai, Tripo3D, generic custom).
//
// Responsibilities:
//   - submit(payload)   -> {ok, provider, task_id, raw}
//   - poll(task_id)     -> {ok, provider, status: PENDING|IN_PROGRESS|SUCCEEDED|FAILED|done,
//                            glb_url?, progress?, error?, raw}
//   - download(url, dst)-> {ok, path}   streams the GLB into a sandbox dir
//   - providers(cfg)    -> [{id,name,configured,is_default}]
//
// All HTTP calls flow through the injected `fetchImpl` so unit tests can mock it
// without touching the network. In production main.js passes global fetch
// (Node 18+). Env vars MESHY_API_KEY / TRIPO_API_KEY override stored settings.
//
// State machine (single source of truth — used by both providers):
//   PENDING       -> just-created, still queued
//   IN_PROGRESS   -> provider is actively generating
//   SUCCEEDED     -> glb_url present, ready to download
//   FAILED        -> error field present
//   'done'        -> our internal terminal marker so callers can stop polling
//                     (covers both SUCCEEDED and FAILED)
// ------------------------------------------------------------------

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_POLL_MS = 6 * 60 * 1000;   // hard ceiling; if a job takes longer the caller should give up
const POLL_DEFAULT_INTERVAL_MS = 3500;
const DOWNLOAD_TIMEOUT_S = 60;

// ----- public API ----------

function submit({ provider, image_data_url, settings, fetchImpl, fetchImplOpts }) {
  if (typeof fetchImpl !== 'function') throw new Error('mesh3d.submit: fetchImpl is required');
  const p = normalizeProvider(provider, settings);
  if (!p.ok) return p;
  const cfg = p.cfg;
  if (p.missingKey) return { ok: false, error: 'api_key_missing:' + p.missingKey };
  if (!image_data_url || typeof image_data_url !== 'string') return { ok: false, error: 'image_required' };
  try {
    if (provider === 'meshy') return _submitMeshy(cfg, image_data_url, fetchImpl);
    if (provider === 'tripo') return _submitTripo(cfg, image_data_url, fetchImpl);
    if (provider === 'custom') return _submitCustom(cfg, image_data_url, fetchImpl);
  } catch (e) {
    return { ok: false, error: 'submit_threw:' + (e && e.message ? e.message : String(e)) };
  }
  return { ok: false, error: 'unknown_provider' };
}

function poll({ provider, task_id, settings, started_at_ms, fetchImpl }) {
  if (typeof fetchImpl !== 'function') throw new Error('mesh3d.poll: fetchImpl is required');
  const p = normalizeProvider(provider, settings);
  if (!p.ok) return p;
  if (!task_id) return { ok: false, error: 'task_id_required' };
  const trimmed = String(task_id).trim();
  if (!trimmed) return { ok: false, error: 'task_id_required' };
  try {
    if (provider === 'meshy') return _pollMeshy(p.cfg, trimmed, fetchImpl);
    if (provider === 'tripo') return _pollTripo(p.cfg, trimmed, fetchImpl);
    if (provider === 'custom') return _pollCustom(p.cfg, trimmed, fetchImpl);
  } catch (e) {
    return { ok: false, error: 'poll_threw:' + (e && e.message ? e.message : String(e)) };
  }
  return { ok: false, error: 'unknown_provider' };
}

// Tracks the started_at_ms cap so callers can poll in a loop without us
// having to expose MAX_POLL_MS twice. If you call poll() with started_at_ms and
// the elapsed wall-clock exceeds the cap, we short-circuit with a sentinel so
// the caller can stop and report timeout rather than hammer the provider.
function pollTimeoutReached(started_at_ms, now_ms) {
  if (typeof started_at_ms !== 'number') return false;
  // started_at_ms === 0 is the test sentinel for "no start" - Date.now() - 0 will
  // exceed MAX_POLL_MS at any reasonable wall-clock time, so it correctly reports timed-out.
  return ((now_ms || Date.now()) - started_at_ms) > MAX_POLL_MS;
}

async function download({ url, dst_dir, fetchImpl, fsImpl }) {
  if (typeof fetchImpl !== 'function') throw new Error('mesh3d.download: fetchImpl is required');
  const f = fsImpl || require('fs');
  const p = pathLib();
  if (!url) return { ok: false, error: 'url_required' };
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'url_not_http' };
  if (!dst_dir) return { ok: false, error: 'dst_dir_required' };
  try { f.mkdirSync(dst_dir, { recursive: true }); } catch (_e) {}
  const filename = _safeFilename(url);
  const fullPath = p.join(dst_dir, filename);
  const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  let timer = null;
  if (controller) timer = setTimeout(function () { try { controller.abort(); } catch (_e) {} }, DOWNLOAD_TIMEOUT_S * 1000);
  try {
    const res = await fetchImpl(url, { signal: controller ? controller.signal : undefined });
    if (!res || !res.ok) return { ok: false, error: 'http_' + (res ? res.status : 'no_response') };
    const ab = await res.arrayBuffer();
    f.writeFileSync(fullPath, Buffer.from(ab));
    return { ok: true, path: fullPath, bytes: ab.byteLength, filename: filename };
  } catch (e) {
    return { ok: false, error: 'download_failed:' + (e && e.message ? e.message : String(e)) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function providers({ settings, env = process.env } = {}) {
  const cfg = (settings && typeof settings === 'object') ? settings : {};
  const m = env.MESHY_API_KEY || cfg.meshApiKey || '';
  const t = env.TRIPO_API_KEY || cfg.tripoApiKey || '';
  const c = (cfg.threeDCustomUrl && cfg.threeDCustomKey) ? true : false;
  const def = (cfg.threeDProvider || 'meshy');
  return [
    { id: 'meshy', name: 'Meshy.ai',  configured: !!m, is_default: def === 'meshy' },
    { id: 'tripo', name: 'Tripo3D',   configured: !!t, is_default: def === 'tripo' },
    { id: 'custom', name: 'Custom',   configured: !!c, is_default: def === 'custom' },
  ];
}

// Computes the runtime-effective provider config: env vars override stored
// settings. Returns either {ok:true, cfg, missingKey?::null} or {ok:false,...}.
function normalizeProvider(provider, settings, env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  const cfg = (settings && typeof settings === 'object') ? settings : {};
  const id = String(provider || cfg.threeDProvider || 'meshy').trim();
  if (id !== 'meshy' && id !== 'tripo' && id !== 'custom') {
    return { ok: false, error: 'unknown_provider:' + id };
  }
  let key;
  if (id === 'meshy') key = e.MESHY_API_KEY || cfg.meshApiKey || '';
  else if (id === 'tripo') key = e.TRIPO_API_KEY || cfg.tripoApiKey || '';
  else key = cfg.threeDCustomKey || '';
  const trimmed = String(key).trim();
  if (!trimmed) return { ok: false, error: 'api_key_missing:' + id };
  const customUrl = (id === 'custom') ? String(cfg.threeDCustomUrl || '').trim() : '';
  if (id === 'custom' && !customUrl) return { ok: false, error: 'custom_url_missing' };
  if (id === 'custom' && !/^https?:\/\//i.test(customUrl)) return { ok: false, error: 'custom_url_not_http' };
  return {
    ok: true,
    cfg: Object.assign({}, cfg, {
      apiKey: trimmed,
      threeDCustomUrl: customUrl,
      threeDFormat: cfg.threeDFormat || 'glb',
      threeDModelPoly: cfg.threeDModelPoly || 'high',
      threeDCustomTemplate: cfg.threeDCustomTemplate || '',
    }),
    missingKey: null,
  };
}

function configured(settings, env) {
  for (const id of ['meshy', 'tripo']) {
    const r = normalizeProvider(id, settings, env);
    if (r.ok) return true;
  }
  const c = normalizeProvider('custom', settings, env);
  return c.ok;
}

// ----- internal helpers ----------

function pathLib() { return require('path'); }

const MESHY_BASE = 'https://api.meshy.ai/openapi/v1';
const TRIPO_BASE = 'https://api.tripo3d.ai/v2';

function _submitMeshy(cfg, image_data_url, fetchImpl) {
  const url = MESHY_BASE + '/image-to-3d';
  const body = {
    image_url: image_data_url,
    model_polycount: cfg.threeDModelPoly || 'high',
    should_texture: true,
    target_formats: [cfg.threeDFormat || 'glb'],
  };
  return fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(_json('meshy_submit')).then(function (j) {
    const tid = (j && (j.result || j.id || j.task_id)) || '';
    if (!tid) return { ok: false, error: 'meshy_no_task_id', raw: j };
    return { ok: true, provider: 'meshy', task_id: String(tid), raw: j };
  });
}

// Tripo needs two HTTP calls: 1) upload the image to get a file_token (multipart),
// 2) POST /task with that token to start generation. We collapse these into one
// `submit()` so the renderer's IPC stays simple. The image is sent as multipart
// because Tripo's upload endpoint requires it (its /task endpoint accepts the
// file_token param, NOT a base64 image).
function _submitTripo(cfg, image_data_url, fetchImpl) {
  // image_data_url is "data:<mime>;base64,<b64>" — strip the prefix and decode for multipart.
  const m = /^data:([^;]+);base64,(.*)$/.exec(image_data_url || '');
  if (!m) return Promise.resolve({ ok: false, error: 'tripo_bad_image_data_url' });
  const mime = m[1] || 'image/png';
  const buf = Buffer.from(m[2] || '', 'base64');
  const ext = mime.indexOf('jpeg') >= 0 ? 'jpg' : (mime.indexOf('png') >= 0 ? 'png' : 'bin');
  const filename = 'upload.' + ext;
  const boundary = '----caryl3d' + Date.now().toString(36);
  const uploadUrl = TRIPO_BASE + '/upload/image/';
  const head = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + filename + '"\r\nContent-Type: ' + mime + '\r\n\r\n', 'utf8');
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8');
  const multipart = Buffer.concat([head, buf, tail]);
  return fetchImpl(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + cfg.apiKey,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
    },
    body: multipart,
  }).then(_json('tripo_upload')).then(function (uploadJson) {
    const fileToken = (uploadJson && (uploadJson.image_token || uploadJson.file_token || uploadJson.token)) || '';
    if (!fileToken) return { ok: false, error: 'tripo_no_file_token', raw: uploadJson };
    const taskUrl = TRIPO_BASE + '/task';
    return fetchImpl(taskUrl, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'image_to_model', file_token: fileToken }),
    }).then(_json('tripo_task')).then(function (j) {
      const tid = (j && (j.data && j.data.task_id) || j.task_id || j.id) || '';
      if (!tid) return { ok: false, error: 'tripo_no_task_id', raw: j };
      return { ok: true, provider: 'tripo', task_id: String(tid), raw: j };
    });
  });
}

// Generic custom provider: a user defines threeDCustomUrl + threeDCustomKey +
// optional threeDCustomTemplate. The default template assumes a single-shot
// POST that returns {task_id|...}. Users with async APIs should override the
// POST + GET to use a sensor-friendly custom flow.
function _submitCustom(cfg, image_data_url, fetchImpl) {
  let body;
  if (cfg.threeDCustomTemplate) {
    // Minimal substitution: {{image_data_url}}, {{format}}, {{polycount}}.
    body = JSON.parse(safeTemplate(cfg.threeDCustomTemplate, {
      image_data_url: image_data_url,
      format: cfg.threeDFormat || 'glb',
      polycount: cfg.threeDModelPoly || 'high',
    }));
  } else {
    body = { image: image_data_url, format: cfg.threeDFormat || 'glb', polycount: cfg.threeDModelPoly || 'high' };
  }
  return fetchImpl(cfg.threeDCustomUrl, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(_json('custom_submit')).then(function (j) {
    const tid = (j && (j.task_id || j.id || j.result)) || '';
    if (!tid) return { ok: false, error: 'custom_no_task_id', raw: j };
    return { ok: true, provider: 'custom', task_id: String(tid), raw: j };
  });
}

function _pollMeshy(cfg, task_id, fetchImpl) {
  const url = MESHY_BASE + '/image-to-3d/' + encodeURIComponent(task_id);
  return fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + cfg.apiKey },
  }).then(_json('meshy_poll')).then(function (j) {
    return _meshShape(j);
  });
}

function _pollTripo(cfg, task_id, fetchImpl) {
  const url = TRIPO_BASE + '/task/' + encodeURIComponent(task_id);
  return fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + cfg.apiKey },
  }).then(_json('tripo_poll')).then(function (j) {
    return _tripoShape(j, task_id);
  });
}

function _pollCustom(cfg, task_id, fetchImpl) {
  // Custom providers vary wildly — expect a GET to <custom_url>/<task_id>.
  // Users with a totally different shape should override this via wrapper code
  // upstream; we don't try to support every vendor's response here.
  const base = cfg.threeDCustomUrl.replace(/\/+$/, '');
  const url = base + '/' + encodeURIComponent(task_id);
  return fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + cfg.apiKey },
  }).then(_json('custom_poll')).then(function (j) {
    const status = (j && (j.status || j.state)) || '';
    const upper = String(status).toUpperCase();
    const done = upper === 'SUCCEEDED' || upper === 'SUCCESS' || upper === 'DONE' || upper === 'COMPLETED';
    const failed = upper === 'FAILED' || upper === 'ERROR';
    if (done) return { ok: true, provider: 'custom', status: 'SUCCEEDED', done: true, glb_url: j.glb_url || j.model_url || (j.result && (j.result.glb_url || j.result.model_url)) || null, progress: 100, raw: j };
    if (failed) return { ok: false, provider: 'custom', status: 'FAILED', done: true, error: (j && j.error) || 'unknown', raw: j };
    return { ok: true, provider: 'custom', status: upper || 'IN_PROGRESS', done: false, progress: (typeof j.progress === 'number') ? Math.round(j.progress * (j.progress <= 1 ? 100 : 1)) : Math.min(99, Math.max(1, Math.round((Date.now() % 90) + 5))), raw: j };
  });
}

function _meshShape(j) {
  const status = ((j && (j.status || (j.progress && 'IN_PROGRESS'))) || 'PENDING').toUpperCase();
  if (status === 'FAILED' || status === 'ERROR') return { ok: false, provider: 'meshy', status: status, done: true, error: (j && (j.error || j.message)) || 'unknown', raw: j };
  if (status === 'SUCCEEDED') {
    const glb = ((j.model_urls || {})[j.format || 'glb']) || (j.model_urls && j.model_urls.glb) || j.glb_url || null;
    if (!glb) return { ok: true, provider: 'meshy', status: 'SUCCEEDED', done: false, raw: j }; // succeeded but no model_url yet — let the caller poll again, a few times
    return { ok: true, provider: 'meshy', status: 'SUCCEEDED', done: true, glb_url: glb, progress: 100, raw: j };
  }
  const pct = (typeof j.progress === 'number') ? j.progress : null;
  return { ok: true, provider: 'meshy', status: status, done: false, progress: pct, raw: j };
}

function _tripoShape(j, task_id) {
  const inner = (j && j.data) || j || {};
  const status = String(inner.status || '').toLowerCase();
  if (status === 'failed' || status === 'error') return { ok: false, provider: 'tripo', status: 'FAILED', done: true, error: inner.message || inner.error || 'unknown', raw: j };
  if (status === 'success' || status === 'succeeded' || status === 'done') {
    const glb = (inner.result && (inner.result.model_url || inner.result.glb_url)) || inner.model_url || inner.glb_url || null;
    if (!glb) return { ok: true, provider: 'tripo', status: 'SUCCEEDED', done: false, raw: j };
    return { ok: true, provider: 'tripo', status: 'SUCCEEDED', done: true, glb_url: glb, progress: 100, raw: j };
  }
  const pct = (typeof inner.progress === 'number') ? inner.progress : null;
  return { ok: true, provider: 'tripo', status: status || 'queued', done: false, progress: pct, raw: j };
}

function _safeFilename(url) {
  try {
    const u = new URL(url);
    const last = (u.pathname || '').split('/').pop() || ('model_' + Date.now() + '.glb');
    return last.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || ('model_' + Date.now() + '.glb');
  } catch (_e) {
    return 'model_' + Date.now() + '.glb';
  }
}

function safeTemplate(tpl, vars) {
  // Context-aware JSON template substitution.
  //
  // The previous implementation unconditionally wrapped substituted values in
  // JSON.stringify(...), which produced invalid JSON whenever a placeholder
  // appeared INSIDE a JSON string the author already opened. Example:
  //   template:"image":"{{format}}"   ->  becomes  "image":""glb""   (BROKEN)
  // because the author's opening/closing quotes surround the placeholder and we
  // tacked our own quotes on top. The right behavior is:
  //   * placeholder OUTSIDE a JSON string   -> inject a JSON literal
  //     (string gets JSON.stringify quoting; number/bool pass through; missing -> null)
  //     so  "key":{{v}}  becomes  "key":"foo" / "key":42 / "key":null
  //   * placeholder INSIDE a JSON string    -> inject RAW text, JSON-escaped
  //     so  "key":"{{v}}"  becomes  "key":"foo"
  //     and missing keys render as the literal text "null" inside the surrounding
  //     string so result is "key":"null" (a valid JSON string).
  //
  // Walk the template char-by-char, tracking unescaped quote state to decide
  // which mode applies per placeholder. Track backslash escapes so a literal
  // \" inside the template does NOT toggle string mode.
  const v = (vars && typeof vars === 'object') ? vars : {};
  const s = String(tpl || '');
  let out = '';
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < s.length) {
    const ch = s[i];
    if (escape) { out += ch; escape = false; i++; continue; }
    if (ch === '\\' && inString) { out += ch; escape = true; i++; continue; }
    if (ch === '"') { out += ch; inString = !inString; i++; continue; }
    if (ch === '{' && s[i + 1] === '{') {
      const close = s.indexOf('}}', i + 2);
      if (close < 0) { out += ch; i++; continue; }
      const key = s.substring(i + 2, close).trim();
      const present = Object.prototype.hasOwnProperty.call(v, key);
      if (inString) {
        // INSIDE the author's string -> raw, JSON-escaped text. Missing key rendered as 'null'.
        if (!present) {
          out += 'null';
        } else {
          const value = v[key];
          if (value === null || value === undefined) {
            out += 'null';
          } else if (typeof value === 'string') {
            out += value
              .replace(/\\/g, '\\\\')
              .replace(/"/g, '\\"')
              .replace(/\n/g, '\\n')
              .replace(/\r/g, '\\r')
              .replace(/\t/g, '\\t');
          } else {
            // Numbers/booleans/objects inside a JSON string: JSON.stringify produces
            // valid textual representation (e.g. 42, true). Objects/arrays become
            // "{...}" / "[...]" which is still valid inside a quoted string.
            out += JSON.stringify(value);
          }
        }
      } else {
        // OUTSIDE the author's string -> inject a JSON literal.
        if (!present) {
          out += 'null';
        } else {
          out += JSON.stringify(v[key]);
        }
      }
      i = close + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// Wrap fetch + parse JSON so every error path gets a single, consistent shape
// ({ ok: false, error: '...' }) before we even inspect the body.
function _json(label) {
  return function (res) {
    if (!res) return Promise.resolve({ ok: false, error: label + ':no_response' });
    if (!res.ok) return res.text().then(function (t) {
      return { ok: false, error: label + ':http_' + res.status, raw: t.slice(0, 800) };
    }).catch(function () {
      return { ok: false, error: label + ':http_' + res.status, raw: null };
    });
    return res.json().then(function (j) { return j; }).catch(function () {
      return res.text().then(function (t) {
        try { return JSON.parse(t); } catch (_e) { return { ok: false, error: label + ':bad_json', raw: t.slice(0, 800) }; }
      });
    });
  };
}

module.exports = {
  submit,
  poll,
  pollTimeoutReached,
  download,
  providers,
  normalizeProvider,
  configured,
  MAX_POLL_MS,
  POLL_DEFAULT_INTERVAL_MS,
  MESHY_BASE,
  TRIPO_BASE,
};
