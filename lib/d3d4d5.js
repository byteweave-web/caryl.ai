// lib/d3d4d5.js
// ------------------------------------------------------------------
// D3 + D4 + D5 IPC bundle for main.js. Owns:
//   - D3: 3D generation IPCs (submit, poll, download, providers, test)
//   - D5: research overlay window + lifecycle IPCs (push-payload via get-payload + update)
//
// Keeps main.js untouched; the host calls install({ ipcMain, app, ... }) once.
//
// D4 (health/diet) is a SYSTEM PROMPT concern handled by the 120B Orchestrator plus the
// renderer's camera-mode buttons (call into the standard vision pipeline with an explicit
// "be honest and direct" injection). No main-process IPC needed for D4.
// ------------------------------------------------------------------

'use strict';

const MESH3D_DOWNLOAD_DIR_NAME = '3d';
const SCHEME_BRAINIMG = 'brainimg';
const RESEARCH_DEFAULT_SIZE = { width: 420, height: 360 };
const RESEARCH_MIN_SIZE = { width: 320, height: 220 };

function install(deps) {
  const { ipcMain, app, BrowserWindow, path, fs, screen, config, mesh3d } = deps;
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new Error('d3d4d5.install: ipcMain is required');
  if (!app || !BrowserWindow || !path) throw new Error('d3d4d5.install: Electron globals are required');

  // ---------------------------------------------------------------- D3: 3D generation
  // Pure HTTP adapter lives in lib/mesh3d.js. Renderer uses these thin IPC wrappers.
  // CRITICAL: the renderer's poll loop MUST throttle to ~3.5s between calls; the adapter
  // is stateless, so an unthrottled renderer hammering `3d:poll` will trigger HTTP 429.
  const threeDDir = path.join(app.getPath('userData'), MESH3D_DOWNLOAD_DIR_NAME);

  ipcMain.handle('3d:submit', async (_e, payload) => _safe(async () => mesh3d.submit({
    provider: payload && payload.provider,
    image_data_url: payload && payload.image_data_url,
    settings: (typeof config.get === 'function') ? config.get() : {},
    fetchImpl: (typeof fetch === 'function') ? fetch : deps.fetch,
  }), 'submit'));

  ipcMain.handle('3d:poll', async (_e, payload) => _safe(async () => mesh3d.poll({
    provider: payload && payload.provider,
    task_id: payload && payload.task_id,
    started_at_ms: (payload && payload.started_at_ms) || Date.now(),
    settings: (typeof config.get === 'function') ? config.get() : {},
    fetchImpl: (typeof fetch === 'function') ? fetch : deps.fetch,
  }), 'poll'));

  ipcMain.handle('3d:download', async (_e, payload) => _safe(async () => {
    if (!payload || typeof payload !== 'object' || !payload.glb_url) return { ok: false, error: 'glb_url_required' };
    const r = await mesh3d.download({ url: payload.glb_url, dst_dir: threeDDir, fetchImpl: (typeof fetch === 'function') ? fetch : deps.fetch });
    if (!r || !r.ok) return r || { ok: false, error: 'download_failed' };
    return Object.assign({ ok: true }, r, { brainimg_url: _brainimgUrl(r.path) });
  }, 'download'));

  ipcMain.handle('3d:providers', async () => _safe(() => {
    const c = (typeof config.get === 'function') ? config.get() : {};
    return { ok: true, providers: mesh3d.providers({ settings: c }), active: c.threeDProvider || 'meshy' };
  }, 'providers'));

  ipcMain.handle('3d:test', async () => _safe(async () => {
    const c = (typeof config.get === 'function') ? config.get() : {};
    const provider = c.threeDProvider || 'meshy';
    // 1x1 PNG - cheap validation smoke test. If the provider rejects it as too small that's
    // STIL prove the key + endpoint work; we don't need SUCCEEDED, just an answered job.
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';
    const r = await mesh3d.submit({ provider: provider, image_data_url: tinyPng, settings: c, fetchImpl: (typeof fetch === 'function') ? fetch : deps.fetch });
    if (!r.ok) return { ok: false, error: r.error || 'submit_failed' };
    // Poll for ~5s — proves the provider acknowledged the job. We don't need it done.
    const start = Date.now();
    let poll = { ok: true, status: 'PENDING' };
    while (Date.now() - start < 5500 && !poll.done) {
      await new Promise(function (r2) { setTimeout(r2, 800); });
      poll = await mesh3d.poll({ provider: provider, task_id: r.task_id, settings: c, fetchImpl: (typeof fetch === 'function') ? fetch : deps.fetch });
      if (!poll.ok) break;
    }
    return { ok: true, provider: provider, task_id: r.task_id, status: poll.status || 'IN_PROGRESS' };
  }, 'test'));

  // ---------------------------------------------------------------- D5: Research overlay
  // A tiny frameless transparent BrowserWindow that shows Researcher-dispatch output without
  // closing camera mode. Created lazily on first `research:open`. Lifecycle: stays open across
  // camera-mode close (the user explicitly clarified: keep camera-open, not close-with-research).
  let overlayWin = null;
  let _latestPayload = null;
  let _cameraModeOpen = false;

  ipcMain.handle('camera:set-session', (_e, open) => {
    _cameraModeOpen = !!open;
    return { ok: true, cameraModeOpen: _cameraModeOpen };
  });

  function _pushUpdate(payload) {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    try { overlayWin.webContents.send('research:update', payload || { kind: 'clear' }); } catch (_e) {}
  }

  function _showPayload(payload) {
    if (overlayWin && !overlayWin.isDestroyed()) {
      _latestPayload = payload || null;
      _pushUpdate(payload || null);
      if (!overlayWin.isVisible()) { try { overlayWin.show(); overlayWin.focus(); } catch (_e) {} }
      return { ok: true, reused: true };
    }
    _latestPayload = payload || null;
    const opts = {
      width: RESEARCH_DEFAULT_SIZE.width, height: RESEARCH_DEFAULT_SIZE.height,
      minWidth: RESEARCH_MIN_SIZE.width, minHeight: RESEARCH_MIN_SIZE.height,
      show: false, frame: false, transparent: true, resizable: true,
      alwaysOnTop: true, skipTaskbar: true, focusable: true,
      backgroundColor: '#00000000', hasShadow: false,
      // Win11 supports DWM acrylic; Win10 falls back to solid blue gradient in the renderer
      // via html[data-os="win10"] CSS so the body still reads correctly.
      ...(process.platform === 'win32' && deps.shellStyle && deps.shellStyle().blur ? { backgroundMaterial: 'acrylic' } : {}),
    };
    try {
      overlayWin = new BrowserWindow(opts);
    } catch (e) {
      return { ok: false, error: 'overlay_create_failed:' + ((e && e.message) || String(e)) };
    }
    // 'floating' tier — above normal windows but NOT fullscreen games / shell context menus.
    // 'screen-saver' would invade fullscreen apps and annoy users — never use that here.
    try { overlayWin.setAlwaysOnTop(true, 'floating'); } catch (_e) {}
    try { overlayWin.loadFile(path.join(__dirname, '..', 'renderer', 'research-overlay.html')); } catch (e) {
      return { ok: false, error: 'overlay_load_failed:' + ((e && e.message) || String(e)) };
    }
    overlayWin.webContents.once('did-finish-load', function () {
      try {
        _pushUpdate(_latestPayload); // initial payload race-free via the onResearchUpdate listener
        overlayWin.show();
        overlayWin.focus();
      } catch (_e) {}
    });
    overlayWin.webContents.on('will-navigate', function (e, url) {
      try {
        const u = new URL(url);
        if (!String(u.pathname || '').endsWith('/renderer/research-overlay.html')) e.preventDefault();
      } catch (_e) { e.preventDefault(); }
    });
    overlayWin.webContents.setWindowOpenHandler(function () { return { action: 'deny' }; });
    overlayWin.on('closed', function () { overlayWin = null; _latestPayload = null; });
    return { ok: true };
  }

  ipcMain.handle('research:open', async (_e, payload) => _safe(() => {
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'payload_required' };
    return _showPayload(payload);
  }, 'research_open'));

  ipcMain.handle('research:close', async () => _safe(() => {
    try { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close(); } catch (_e) {}
    overlayWin = null; _latestPayload = null;
    return { ok: true };
  }, 'research_close'));

  // Synchronous read of the latest payload — overlay calls this on first mount, BEFORE its
  // onResearchUpdate listener has had a chance to fire for THIS session. Together they make
  // the per-mount payload race-free even if the renderer fires many research:open calls back
  // to back (each subsequent call just pushes an update; no teardown/relaunch).
  ipcMain.handle('research:get-payload', async () => _latestPayload);

  ipcMain.handle('research:set-pin', async (_e, pinned) => _safe(() => {
    if (!overlayWin || overlayWin.isDestroyed()) return { ok: false, error: 'not_open' };
    // Pin-tier toggle: pinned=true -> 'screen-saver' (over everything, fullscreen apps
    // included); pinned=false -> 'floating' (normal windows only, never invades fullscreen).
    // The thinker's review caught the previous no-op (always 'floating' regardless of arg).
    const tier = pinned ? 'screen-saver' : 'floating';
    try { overlayWin.setAlwaysOnTop(true, tier); } catch (_e) {}
    return { ok: true, pinned: !!pinned, tier: tier };
  }, 'research_pin'));
}

function _safe(fn, label) {
  return Promise.resolve()
    .then(function () { return fn(); })
    .catch(function (e) { return { ok: false, error: 'd3d4d5_' + label + ':' + ((e && e.message) || String(e)) }; });
}

function _brainimgUrl(absPath) {
  // brainimg:// is registered as standard+secure+fetch-supporting at startup; main.js also
  // needs to add a fetch handler so the renderer can actually load the bytes. If you skip
  // registering brainimg fetching, this URL just won't resolve — the renderer will see an
  // empty model. Register brainimg fetch BEFORE install() (typically at app boot).
  return SCHEME_BRAINIMG + ':///' + encodeURI(String(absPath).replace(/\\/g, '/').replace(/^\//, ''));
}

module.exports = { install };
