// tests/test-mesh3d.js
// Unit tests for the 3D model generation adapter. Each provider's submit
// and poll flow is exercised against a small fake fetch, including state
// transitions, missing-key short-circuits, the multipart boundary for Tripo,
// env-var precedence, and a clean failure path on download.
//
// Run with: `node tests/test-mesh3d.js` (no mocha, no electron).
'use strict';

const assert = require('assert');
const path = require('path');
const mesh3d = require('../lib/mesh3d');

const SAMPLE_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=', 'base64');

function mockFetch(responses) {
  // responses: array of {url, method?, match?, status, body} OR {match:function, body}
  const calls = [];
  const fn = function (url, opts) {
    calls.push({ url: url, opts: opts || {}, method: (opts && opts.method) || 'GET' });
    const r = responses.find(function (entry) {
      if (entry.url && entry.url !== url) return false;
      if (entry.method && (entry.method || 'GET').toUpperCase() !== ((opts && opts.method) || 'GET').toUpperCase()) return false;
      if (entry.match && !entry.match(url, opts)) return false;
      return true;
    });
    if (!r) return Promise.resolve({ ok: false, status: 599, json: function () { return Promise.resolve({ error: 'no_mock_route', url: url }); } });
    if (r.throw) throw new Error('mock-throw');
    const body = typeof r.body === 'function' ? r.body(url, opts || {}) : r.body;
    return Promise.resolve({
      ok: r.status === undefined || (r.status >= 200 && r.status < 300),
      status: r.status || 200,
      json: function () { return Promise.resolve(body); },
      text: function () { return Promise.resolve(JSON.stringify(body)); },
      arrayBuffer: function () { const b = Buffer.from(r.bytes || 'mockbytes'); return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); },
    });
  };
  return { fetchImpl: fn, calls: calls };
}

// ---------- providers / configured ----------

const baseCfg = { threeDProvider: 'meshy', meshApiKey: 'stored-mesh', tripoApiKey: 'stored-tripo', threeDCustomUrl: 'https://example.test/3d', threeDCustomKey: 'stored-custom' };

assert.deepStrictEqual(
  mesh3d.providers({ settings: baseCfg }).map(function (p) { return p.id + ':' + p.configured; }),
  ['meshy:true', 'tripo:true', 'custom:true'],
  'all three providers report configured when keys are present'
);
assert.ok(mesh3d.configured(baseCfg), 'configured() with all three set');

// env var overrides stored key (real MESHY_API_KEY behavior)
const env = { MESHY_API_KEY: 'env-mesh' };
const norm = mesh3d.normalizeProvider('meshy', { meshApiKey: 'stored-mesh' }, env);
assert.strictEqual(norm.ok, true);
assert.strictEqual(norm.cfg.apiKey, 'env-mesh', 'env var overrides stored key');
assert.deepStrictEqual(mesh3d.providers({ settings: { meshApiKey: '' }, env: env }).find(function (p) { return p.id === 'meshy'; }).configured, true, 'env-only key still counts as configured');

// missing key short-circuits
const r = mesh3d.normalizeProvider('meshy', { meshApiKey: '' }, {});
assert.strictEqual(r.ok, false);
assert.ok(/api_key_missing/.test(r.error), 'reports missing key: ' + r.error);
const s = mesh3d.submit({ provider: 'meshy', image_data_url: SAMPLE_PNG_DATA_URL, settings: { meshApiKey: '' }, fetchImpl: function () { throw new Error('should not call fetch'); } });
(async function () {
  const sub = await s;
  assert.strictEqual(sub.ok, false);
  assert.ok(/api_key_missing/.test(sub.error));

  // ---------- Meshy submit + happy poll path ----------
  const ok1 = mockFetch([
    { url: 'https://api.meshy.ai/openapi/v1/image-to-3d', method: 'POST', status: 200, body: { result: 'task-aaa' } },
    { url: 'https://api.meshy.ai/openapi/v1/image-to-3d/task-aaa', method: 'GET', status: 200, body: { status: 'SUCCEEDED', model_urls: { glb: 'https://cdn.meshy.ai/task-aaa.glb' } } },
  ]);
  const sub2 = await mesh3d.submit({ provider: 'meshy', image_data_url: SAMPLE_PNG_DATA_URL, settings: { meshApiKey: 'ms' }, fetchImpl: ok1.fetchImpl });
  assert.strictEqual(sub2.ok, true, 'meshy submit ok');
  assert.strictEqual(sub2.provider, 'meshy');
  assert.strictEqual(sub2.task_id, 'task-aaa');
  const headers1 = ok1.calls[0].opts.headers || {};
  assert.strictEqual(headers1.Authorization, 'Bearer ms', 'meshy sends bearer token');
  assert.ok(/JSON.stringify/.test(Object.prototype.toString.call(headers1)) === false, 'no-sync-shim');
  assert.strictEqual(headers1['Content-Type'], 'application/json');
  assert.ok((ok1.calls[0].opts.body || '').indexOf('"image_url":"data:image/png;base64,') >= 0, 'meshy receives the data URL as image_url');
  assert.ok((ok1.calls[0].opts.body || '').indexOf('"model_polycount":"high"') >= 0, 'default polycount is in the payload');
  assert.ok((ok1.calls[0].opts.body || '').indexOf('"target_formats":["glb"]') >= 0, 'default format is in the payload');

  const poll1 = await mesh3d.poll({ provider: 'meshy', task_id: 'task-aaa', settings: { meshApiKey: 'ms' }, fetchImpl: ok1.fetchImpl });
  assert.strictEqual(poll1.ok, true);
  assert.strictEqual(poll1.status, 'SUCCEEDED');
  assert.strictEqual(poll1.done, true);
  assert.strictEqual(poll1.glb_url, 'https://cdn.meshy.ai/task-aaa.glb');

  // in-progress -> not done
  const ok2 = mockFetch([
    { url: 'https://api.meshy.ai/openapi/v1/image-to-3d/task-bbb', method: 'GET', status: 200, body: { status: 'IN_PROGRESS', progress: 42 } },
  ]);
  const poll2 = await mesh3d.poll({ provider: 'meshy', task_id: 'task-bbb', settings: { meshApiKey: 'ms' }, fetchImpl: ok2.fetchImpl });
  assert.strictEqual(poll2.done, false);
  assert.strictEqual(poll2.progress, 42);

  // FAILED -> ok:false, done:true, error present
  const ok3 = mockFetch([
    { url: 'https://api.meshy.ai/openapi/v3/image-to-3d/task-ccc', method: 'GET', status: 200, body: { status: 'FAILED', error: 'payment_required' } },
    { url: 'https://api.meshy.ai/openapi/v1/image-to-3d/task-ccc', method: 'GET', status: 200, body: { status: 'FAILED', error: 'payment_required' } },
  ]);
  const poll3 = await mesh3d.poll({ provider: 'meshy', task_id: 'task-ccc', settings: { meshApiKey: 'ms' }, fetchImpl: ok3.fetchImpl });
  assert.strictEqual(poll3.ok, false);
  assert.strictEqual(poll3.done, true);
  assert.ok(/payment_required/.test(poll3.error));

  // ---------- Tripo submit (multipart) + happy poll ----------
  const okTri = mockFetch([
    { url: 'https://api.tripo3d.ai/v2/upload/image/', method: 'POST', status: 200, body: { image_token: 'tok-xyz' } },
    { url: 'https://api.tripo3d.ai/v2/task', method: 'POST', status: 200, body: { data: { task_id: 'tripo-task-1' } } },
    { url: 'https://api.tripo3d.ai/v2/task/tripo-task-1', method: 'GET', status: 200, body: { data: { status: 'success', result: { model_url: 'https://cdn.tripo3d.ai/tripo-task-1.glb' } } } },
  ]);
  const subTri = await mesh3d.submit({ provider: 'tripo', image_data_url: SAMPLE_PNG_DATA_URL, settings: { tripoApiKey: 'tt' }, fetchImpl: okTri.fetchImpl });
  assert.strictEqual(subTri.ok, true, 'tripo submit ok');
  assert.strictEqual(subTri.task_id, 'tripo-task-1');
  const uploadHeaders = okTri.calls[0].opts.headers || {};
  assert.ok(/^multipart\/form-data; boundary=/.test(uploadHeaders['Content-Type'] || ''), 'tripo upload uses multipart/form-data with boundary');
  assert.strictEqual(uploadHeaders.Authorization, 'Bearer tt');
  // The body should contain the boundary + filename + raw PNG bytes verbatim.
  const uploadBody = okTri.calls[0].opts.body;
  assert.ok(Buffer.isBuffer(uploadBody), 'upload body is a Buffer');
  assert.ok(uploadBody.indexOf(PNG_BYTES) >= 0, 'multipart body carries the decoded PNG bytes');
  assert.ok(/Content-Disposition: form-data; name="file"; filename="upload\.png"/.test(uploadBody.toString('utf8')), 'multipart body uses field name "file" + filename');
  // second call: POST /task with the file_token
  const taskHeaders = okTri.calls[1].opts.headers || {};
  assert.strictEqual(taskHeaders['Content-Type'], 'application/json');
  assert.ok(JSON.parse(okTri.calls[1].opts.body).file_token === 'tok-xyz', 'task create uses the upload token');
  assert.strictEqual(JSON.parse(okTri.calls[1].opts.body).type, 'image_to_model');

  // polled -> done:true with model_url
  const pollTri = await mesh3d.poll({ provider: 'tripo', task_id: 'tripo-task-1', settings: { tripoApiKey: 'tt' }, fetchImpl: okTri.fetchImpl });
  assert.strictEqual(pollTri.ok, true);
  assert.strictEqual(pollTri.done, true);
  assert.strictEqual(pollTri.glb_url, 'https://cdn.tripo3d.ai/tripo-task-1.glb');

  // queued -> not done
  const okTri2 = mockFetch([
    { url: 'https://api.tripo3d.ai/v2/task/tripo-task-2', method: 'GET', status: 200, body: { data: { status: 'queued' } } },
  ]);
  const pollTri2 = await mesh3d.poll({ provider: 'tripo', task_id: 'tripo-task-2', settings: { tripoApiKey: 'tt' }, fetchImpl: okTri2.fetchImpl });
  assert.strictEqual(pollTri2.done, false);
  assert.strictEqual(pollTri2.status, 'queued');

  // bad image data URL -> submit short-circuits, never calls fetch
  let called = false;
  const subBad = await mesh3d.submit({ provider: 'tripo', image_data_url: 'not-a-data-url', settings: { tripoApiKey: 'tt' }, fetchImpl: function () { called = true; return Promise.resolve({}); } });
  assert.strictEqual(subBad.ok, false);
  assert.ok(/tripo_bad_image_data_url/.test(subBad.error));
  assert.strictEqual(called, false);

  // ---------- Custom provider + template substitution ----------
  const okCust = mockFetch([
    { url: 'https://example.test/3d', method: 'POST', status: 200, body: { task_id: 'cust-1' } },
    { url: 'https://example.test/3d/cust-1', method: 'GET', status: 200, body: { status: 'DONE', glb_url: 'https://example.test/cust-1.glb' } },
  ]);
  const customSettings = {
    threeDCustomKey: 'ck',
    threeDCustomUrl: 'https://example.test/3d',
    threeDCustomTemplate: '{"id":"job-{{id}}","image":{{image_data_url}},"format":"{{format}}"}',
    threeDFormat: 'glb',
  };
  const subCust = await mesh3d.submit({ provider: 'custom', image_data_url: SAMPLE_PNG_DATA_URL, settings: customSettings, fetchImpl: okCust.fetchImpl });
  assert.strictEqual(subCust.ok, true);
  const sentBody = JSON.parse(okCust.calls[0].opts.body);
  assert.strictEqual(sentBody.id, 'job-null', 'missing template key becomes JSON null (safe-by-default; never invalid JSON)');
  assert.ok(sentBody.image === SAMPLE_PNG_DATA_URL, 'default template queues image_data_url when called without a template');
  // with a key in the template now:
  const customSettings2 = Object.assign({}, customSettings, { threeDCustomTemplate: '{"id":"job-42","image":{{image_data_url}},"fmt":"{{format}}","poly":"{{polycount}}"}' });
  const okCust2 = mockFetch([
    { url: 'https://example.test/3d', method: 'POST', status: 200, body: { task_id: 'cust-2' } },
  ]);
  const subCust2 = await mesh3d.submit({ provider: 'custom', image_data_url: SAMPLE_PNG_DATA_URL, settings: customSettings2, fetchImpl: okCust2.fetchImpl });
  assert.strictEqual(subCust2.ok, true);
  const sent2 = JSON.parse(okCust2.calls[0].opts.body);
  assert.strictEqual(sent2.fmt, 'glb', 'template substitutes {{format}}');
  assert.strictEqual(sent2.poly, 'high', 'template substitutes {{polycount}}');
  const pollCust = await mesh3d.poll({ provider: 'custom', task_id: 'cust-1', settings: customSettings, fetchImpl: okCust.fetchImpl });
  assert.strictEqual(pollCust.done, true);
  assert.strictEqual(pollCust.glb_url, 'https://example.test/cust-1.glb');

  // custom without a url is rejected
  const normNoUrl = mesh3d.normalizeProvider('custom', { threeDCustomKey: 'ck' });
  assert.strictEqual(normNoUrl.ok, false);
  assert.ok(/custom_url_missing/.test(normNoUrl.error));

  // ---------- pollTimeoutReached ----------
  assert.strictEqual(mesh3d.pollTimeoutReached(0, Date.now()), true, 'no start -> always timed out (defensive)');
  const futureStart = Date.now() - 1000;
  assert.strictEqual(mesh3d.pollTimeoutReached(futureStart, Date.now()), false, '1s after start -> not timed out');
  const longAgo = Date.now() - (mesh3d.MAX_POLL_MS + 1000);
  assert.strictEqual(mesh3d.pollTimeoutReached(longAgo, Date.now()), true, 'past cap -> timed out');

  // ---------- download ----------

  const tmp = path.join(require('os').tmpdir(), 'caryl-test-' + Date.now());
  require('fs').mkdirSync(tmp, { recursive: true });
  const okDl = mockFetch([
    { url: 'https://cdn.meshy.ai/task-aaa.glb', method: 'GET', status: 200, bytes: 'GLB-bytes-here' },
  ]);
  const dl = await mesh3d.download({ url: 'https://cdn.meshy.ai/task-aaa.glb', dst_dir: tmp, fetchImpl: okDl.fetchImpl });
  assert.strictEqual(dl.ok, true);
  assert.ok(dl.path.endsWith('task-aaa.glb'), 'file lands at the URL-derived name: ' + dl.path);
  assert.strictEqual(require('fs').readFileSync(dl.path, 'utf8'), 'GLB-bytes-here');

  // download refuses non-http url
  const dlBad = await mesh3d.download({ url: 'file:///etc/passwd', dst_dir: tmp, fetchImpl: okDl.fetchImpl });
  assert.strictEqual(dlBad.ok, false);
  assert.ok(/url_not_http/.test(dlBad.error));

  // download refuses missing url
  const dlNone = await mesh3d.download({ url: '', dst_dir: tmp, fetchImpl: okDl.fetchImpl });
  assert.strictEqual(dlNone.ok, false);

  console.log('test-mesh3d: all assertions passed');
})().catch(function (e) { console.error(e); process.exit(1); });
