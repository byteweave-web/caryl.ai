// lib/kernel/overlay.js
// The Kernel Overlay Card: a dedicated, lightweight always-on-top window that renders
// handler results — kind:'forecast' (iOS-style weather strip) or kind:'rows' (label/value
// list). This is the ONLY Electron-touching module under lib/kernel/; the pure kernel core
// never imports it (main.js is the composition point), so kernel suites stay plain-node.
//
// Pure pieces (normalizePayload / resolveAccent / mapIcon) are exported for tests; the
// window shell (open / update / scrollTo / dismiss / isOpen) is added below them.

// Card-local semantic accent palette. A payload accent that isn't listed here returns
// null and the renderer falls back to the user's theme --accent.
const ACCENTS = {
  sky:    { accent: '#6fc3ff', soft: 'rgba(111,195,255,.16)' },
  blue:   { accent: '#4c8dff', soft: 'rgba(76,141,255,.16)' },
  teal:   { accent: '#35d6b0', soft: 'rgba(53,214,176,.16)' },
  amber:  { accent: '#f5b53d', soft: 'rgba(245,181,61,.16)' },
  violet: { accent: '#a98bff', soft: 'rgba(169,139,255,.16)' }
};

function resolveAccent(name) {
  return ACCENTS[String(name || '')] || null;
}

// The weather handler now emits FINAL sprite ids (it maps WMO codes with per-entry day/night
// info the card can't see). mapIcon just validates: a known sprite id passes through, anything
// else (junk, a stale OpenWeather code, undefined) falls back to 'cloud'.
const SPRITES = new Set(['sun', 'moon', 'partly', 'cloud', 'drizzle', 'rain', 'thunder', 'snow', 'mist']);
function mapIcon(id) {
  return SPRITES.has(String(id)) ? String(id) : 'cloud';
}

const MAX_ROWS = 12;
const SCENES = ['clear-day', 'clear-night', 'clouds', 'rain', 'storm', 'snow', 'mist'];
const MAX_HOURLY = 8, MAX_DAILY = 6;

function str(v, fallback) {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s || fallback;
}

function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
function rnd(v) { const n = num(v); return n == null ? null : Math.round(n); }

// Any payload -> a safe render model the card can draw without ever seeing undefined.
// kind:'forecast' REQUIRES non-empty hourly[] AND >=2 daily[] rows; anything else demotes to 'rows'.
function normalizePayload(p) {
  p = (p && typeof p === 'object') ? p : {};
  const title = str(p.title, 'Caryl');
  const accent = str(p.accent, '');

  const rows = (Array.isArray(p.rows) ? p.rows : [])
    .filter((r) => r && typeof r === 'object')
    .slice(0, MAX_ROWS)
    .map((r) => ({ label: str(r.label, ''), value: str(r.value, '') }));

  const hourly = (Array.isArray(p.hourly) ? p.hourly : [])
    .filter((t) => t && typeof t === 'object')
    .slice(0, MAX_HOURLY)
    .map((t) => ({ time: str(t.time, '--:--'), temp: rnd(t.temp) || 0,
                   icon: mapIcon(t.icon), condition: str(t.condition, ''),
                   pop: Math.max(0, Math.min(100, rnd(t.pop) || 0)) }));
  const daily = (Array.isArray(p.daily) ? p.daily : [])
    .filter((d) => d && typeof d === 'object')
    .slice(0, MAX_DAILY)
    .map((d) => ({ day: str(d.day, ''), icon: mapIcon(d.icon),
                   lo: rnd(d.lo) || 0, hi: rnd(d.hi) || 0,
                   pop: Math.max(0, Math.min(100, rnd(d.pop) || 0)) }));
  if (p.kind === 'forecast' && hourly.length > 0 && daily.length >= 2) {
    const cur = (p.current && typeof p.current === 'object') ? p.current : {};
    const wind = (cur.wind && typeof cur.wind === 'object') ? cur.wind : {};
    const moon = (cur.moon && typeof cur.moon === 'object') ? cur.moon : {};
    const narration = (Array.isArray(p.narration) ? p.narration : [])
      .filter((n) => n && typeof n === 'object' && str(n.text, ''))
      .map((n) => ({ text: str(n.text, ''),
                     tile: Math.min(hourly.length - 1, Math.max(0, Number(n.tile) || 0)) }));
    return {
      kind: 'forecast', title, accent,
      scene: SCENES.indexOf(p.scene) >= 0 ? p.scene : 'clouds',
      current: {
        units: cur.units === 'imperial' ? 'imperial' : 'metric',
        temp: rnd(cur.temp), hi: rnd(cur.hi), lo: rnd(cur.lo),
        icon: mapIcon(cur.icon), condition: str(cur.condition, ''),
        feelsLike: rnd(cur.feelsLike), humidity: rnd(cur.humidity), dewPoint: rnd(cur.dewPoint),
        pressure: rnd(cur.pressure), visibility: num(cur.visibility),
        wind: { speed: rnd(wind.speed), gust: rnd(wind.gust), deg: rnd(wind.deg) },
        sunrise: str(cur.sunrise, ''), sunset: str(cur.sunset, ''),
        isNight: !!cur.isNight,
        moon: { phase: str(moon.phase, ''), illumination: Math.max(0, Math.min(100, rnd(moon.illumination) || 0)) }
      },
      hourly, daily, narration, rows: []
    };
  }

  return { kind: 'rows', title, accent, rows, current: null, forecast: [], narration: [] };
}

// ============================================================================
// Window shell. Everything below touches Electron; nothing above does.
// The window is created once, reused, and hidden (not destroyed) between cards.
// ============================================================================
let _electron = null;
function electron() { return _electron || (_electron = require('electron')); }

// Phase 5 (Unified OS): whenever our satellite windows show/hide/move, tell the main
// renderer which shell corners they cover (the slot allocator ghosts/re-anchors around
// them). publish() self-hooks move/resize/etc. on every window it sees, so after the
// first call the windows keep the occupancy fresh on their own.
function publishSlots() { try { require('../shell-slots').publish(electron()); } catch (_e) {} }

let win = null;             // the one card BrowserWindow (kind:'rows')
let boardWin = null;         // the weather board window (kind:'forecast', second surface)
let liveKind = 'rows';       // which surface owns currentId ('rows' | 'forecast')
let boundsSaveTimer = null;  // debounces weatherBoardBounds persistence
let cardSeq = 0;            // monotonic id; stale scrollTo/dismiss calls are ignored
let currentId = 0;          // id of the card currently showing (0 = none)
let safetyTimer = null;
// PER-SURFACE pending-hide state, keyed 'card'/'board'. A dismissed surface fades in its
// renderer, then acks card:faded (-> notifyFaded) to be hidden; this fallback timer only
// hides it if that ack is lost. Keeping one entry PER surface is what stops a different-kind
// open() (mid-fade of the other surface) from cancelling the wrong surface's pending hide -
// which previously orphaned an invisible, still-on-top window.
const pendingHide = { card: null, board: null }; // each: { win, timer } | null
const SAFETY_MS = 30000;    // force-dismiss if no speech-end ever arrives
// Normal hide arrives via the renderer's card:faded ack (sent once its fade-out transition
// finishes). This fallback only fires if that ack is ever lost (e.g. renderer crashed mid-fade),
// so it's generous rather than tight - a real ack always beats it in practice.
const HIDE_FALLBACK_MS = 60000;

// Latest requested card while a window is still loading (createWin/createBoardWin ->
// did-finish-load). { model, width, height, id, target } | null ('target': 'card'|'board').
// Consumed (and nulled) by renderPending().
let pending = null;

// deps injected by main.js at first use: { preloadPath, shellStyle, getConfig, saveConfig }
let deps = null;
function init(d) { deps = d; }

function sizeFor(model) {
  if (model.kind === 'forecast') return { width: 440, height: 268 };
  return { width: 340, height: Math.min(420, 128 + 38 * Math.max(1, model.rows.length)) };
}

// Same on-screen-reachability rule as main.js's isOnScreen (module-local copy - overlay.js
// doesn't import main.js). A saved rect from a previous session might no longer be reachable
// (monitor unplugged, resolution changed); only trust it if it still overlaps a live display.
function isOnScreenRect(b) {
  try {
    const { screen } = electron();
    return screen.getAllDisplays().some((d) => {
      const wa = d.workArea;
      return b.x + b.width > wa.x + 20 && b.x < wa.x + wa.width - 20 &&
             b.y + b.height > wa.y + 20 && b.y < wa.y + wa.height - 20;
    });
  } catch (_e) { return false; }
}

// Bounds for a fresh board window: the saved rect if it's still on-screen, else a centered
// rect scaled off the primary work area (weatherCardScale, clamped so the board never gets
// too small to read or larger than the screen).
function boardBounds() {
  const cfg = (deps.getConfig && deps.getConfig()) || {};
  const saved = cfg.weatherBoardBounds;
  if (saved && saved.width > 200 && isOnScreenRect(saved)) return saved;
  const { screen } = electron();
  const wa = screen.getPrimaryDisplay().workArea;
  const scale = Math.max(0.65, Math.min(1, Number(cfg.weatherCardScale) || 0.65));
  const width = Math.round(wa.width * scale), height = Math.round(wa.height * scale);
  return { x: wa.x + Math.round((wa.width - width) / 2), y: wa.y + Math.round((wa.height - height) / 2), width, height };
}

function createWin(w, h) {
  const { BrowserWindow, screen } = electron();
  const wa = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    x: wa.x + Math.round((wa.width - w) / 2),
    y: wa.y + Math.round((wa.height - h) / 2),
    width: w, height: h,
    frame: false, transparent: true, hasShadow: false, resizable: false, roundedCorners: false,
    skipTaskbar: true, alwaysOnTop: true, show: false, fullscreenable: false,
    backgroundColor: '#00000000',
    backgroundMaterial: (process.platform === 'win32' && deps.shellStyle().blur) ? 'acrylic' : undefined,
    webPreferences: {
      preload: deps.preloadPath,
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // Same capture exclusion as the HUD panel/bubble: the automation vision loop must never
  // see our own card sitting over the desktop (see createOverlay() in main.js).
  try { win.setContentProtection(true); } catch (_e) {}
  win.loadFile(require('path').join(__dirname, '..', '..', 'renderer', 'overlay-card.html'));
  win.on('closed', () => { win = null; if (liveKind === 'rows') currentId = 0; });
  return win;
}

// The weather board: a resizable, user-repositionable second surface for kind:'forecast'.
// Bounds come from boardBounds() on creation; the user's own moves/resizes are persisted
// (debounced) back to config as weatherBoardBounds so the board reopens where they left it.
function createBoardWin(b) {
  const { BrowserWindow } = electron();
  boardWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, transparent: true, hasShadow: false, resizable: true, roundedCorners: false,
    skipTaskbar: true, alwaysOnTop: true, show: false, fullscreenable: false,
    backgroundColor: '#00000000',
    backgroundMaterial: (process.platform === 'win32' && deps.shellStyle().blur) ? 'acrylic' : undefined,
    webPreferences: { preload: deps.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false }
  });
  boardWin.setAlwaysOnTop(true, 'screen-saver');
  try { boardWin.setContentProtection(true); } catch (_e) {}
  boardWin.loadFile(require('path').join(__dirname, '..', '..', 'renderer', 'weather-board.html'));
  const persist = () => {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      if (boardWin && !boardWin.isDestroyed() && deps.saveConfig) deps.saveConfig({ weatherBoardBounds: boardWin.getBounds() });
    }, 400);
  };
  boardWin.on('moved', persist);
  boardWin.on('resize', persist);
  boardWin.on('closed', () => { boardWin = null; if (liveKind === 'forecast') currentId = 0; });
  return boardWin;
}

function winFor(target) { return target === 'board' ? boardWin : win; }

// Is `surface` ('card'|'board') the one that currently owns a live (non-zero) card?
function surfaceIsLive(surface) {
  return currentId !== 0 && ((surface === 'board') === (liveKind === 'forecast'));
}

// Cancel a surface's pending-hide fallback timer without hiding it (the window is being
// reused / re-shown, or torn down).
function clearPendingHide(surface) {
  const p = pendingHide[surface];
  if (p && p.timer) clearTimeout(p.timer);
  pendingHide[surface] = null;
}

// Hide a surface's window now (fade is done / ack lost) unless it has meanwhile become the
// live surface again, then clear its pending-hide entry.
function hidePending(surface) {
  const p = pendingHide[surface];
  pendingHide[surface] = null;
  if (p && p.timer) clearTimeout(p.timer);
  if (p && p.win && !p.win.isDestroyed() && !surfaceIsLive(surface)) p.win.hide();
  publishSlots();
}

function send(channel, arg, target) {
  const w = winFor(target);
  if (w && !w.isDestroyed()) { try { w.webContents.send(channel, arg); } catch (_e) {} }
}

// Consumes `pending` (the latest requested card/board) and actually renders it. Bound to
// did-finish-load on first create; called directly by open() once the window is ready.
// Always renders the NEWEST pending model - a second open() that arrived while the window
// was still loading overwrites `pending` rather than firing its own (dropped) send().
function renderPending() {
  if (!pending || pending.id !== currentId) return;
  const { model, width, height, target } = pending;
  const w = winFor(target);
  if (!w || w.isDestroyed()) return;
  pending = null;
  if (target === 'board') {
    // A fresh window already sits at boardBounds(); only re-bound a reused, already-visible
    // window if the user hasn't repositioned it (i.e. always trust boardBounds() on create,
    // otherwise keep whatever bounds it currently has - respect an in-flight user resize).
    if (!w.isVisible()) w.setBounds(boardBounds());
  } else {
    const { screen } = electron();
    const wa = screen.getPrimaryDisplay().workArea;
    w.setBounds({ x: wa.x + Math.round((wa.width - width) / 2), y: wa.y + Math.round((wa.height - height) / 2), width, height });
  }
  send('card:render', model, target);
  w.showInactive();
  publishSlots();
}

// Show a card or weather board. Returns { cardId, kind } (pass cardId to scrollTo/dismiss
// to guard against staleness; kind tells the caller which surface is now live).
function open(payload) {
  if (!deps) return { cardId: 0, kind: 'rows' };
  const model = normalizePayload(payload);
  model.accentColors = resolveAccent(model.accent); // concrete colors ride the payload
  const target = model.kind === 'forecast' ? 'board' : 'card';

  // Only one surface is ever live. A SAME-kind open reuses its window (renderPending), so
  // superseding is automatic - but a CROSS-kind open (e.g. a rows result while the board is
  // still up) would leave the other window visible AND un-closable: dismiss() targets the
  // now-live surface, so the orphan's own x/Esc/blur would close the NEW card instead of
  // itself. Hide the previously-live other surface here before it can strand.
  const prevSurface = liveKind === 'forecast' ? 'board' : 'card';
  if (currentId !== 0 && prevSurface !== target) {
    clearPendingHide(prevSurface);
    const pw = winFor(prevSurface);
    if (pw && !pw.isDestroyed() && pw.isVisible()) pw.hide();
  }

  const id = ++cardSeq;
  currentId = id;
  liveKind = model.kind;
  const { width, height } = sizeFor(model);
  pending = { model, width, height, id, target };

  // Reusing/re-showing THIS surface's window supersedes its own pending hide - but must NOT
  // touch the other surface's pending hide (that window is still fading out on its own).
  clearPendingHide(target);

  if (target === 'board') {
    if (!boardWin || boardWin.isDestroyed()) {
      createBoardWin(boardBounds());
      boardWin.webContents.once('did-finish-load', renderPending);
    } else if (boardWin.webContents.isLoading()) {
      // Already-queued did-finish-load will render whatever is in `pending` when it fires.
    } else {
      renderPending();
    }
    // The board persists until the user closes it - no safety timer.
  } else {
    if (!win || win.isDestroyed()) {
      createWin(width, height);
      win.webContents.once('did-finish-load', renderPending);
    } else if (win.webContents.isLoading()) {
      // Already-queued did-finish-load (from the first open() during this load) will render
      // whatever is in `pending` when it fires - which is now this newest call.
    } else {
      renderPending();
    }

    if (safetyTimer) clearTimeout(safetyTimer);
    safetyTimer = setTimeout(() => dismiss('safety-timeout', id), SAFETY_MS);
  }
  return { cardId: id, kind: model.kind };
}

function scrollTo(index, cardId) {
  if (cardId && cardId !== currentId) return; // stale narration event
  send('card:scrollTo', index, liveKind === 'forecast' ? 'board' : 'card');
}

function dismiss(reason, cardId) {
  if (liveKind === 'forecast' && (reason === 'speech-end' || reason === 'no-tts')) return; // board persists
  if (cardId && cardId !== currentId) return; // stale (a newer card is up)
  const target = liveKind === 'forecast' ? 'board' : 'card';
  const w = winFor(target);
  if (!w || w.isDestroyed() || currentId === 0) return;
  currentId = 0;
  if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
  send('card:dismiss', reason, target);
  // The renderer acks with card:faded once its fade-out transition actually completes (see
  // notifyFaded() below); this per-surface fallback only hides us if that ack is ever lost.
  clearPendingHide(target);
  pendingHide[target] = {
    win: w,
    timer: setTimeout(() => hidePending(target), HIDE_FALLBACK_MS)
  };
}

// Called on the renderer's card:faded ack. `senderWc` identifies WHICH window's renderer
// acked (its fade-out transition finished), so the right surface is hidden even if a
// different-kind card opened during the fade. With no sender (legacy call), fall back to
// hiding whichever non-live surface still has a pending hide.
function notifyFaded(senderWc) {
  let surface = null;
  if (senderWc) {
    if (win && !win.isDestroyed() && win.webContents === senderWc) surface = 'card';
    else if (boardWin && !boardWin.isDestroyed() && boardWin.webContents === senderWc) surface = 'board';
  }
  if (surface) { hidePending(surface); return; }
  // Unidentified ack (or window already gone): best-effort hide of any non-live pending surface.
  if (pendingHide.card) hidePending('card');
  if (pendingHide.board) hidePending('board');
}

function isOpen() {
  const w = liveKind === 'forecast' ? boardWin : win;
  return currentId !== 0 && !!w && !w.isDestroyed() && w.isVisible();
}

// Tear both windows down for real (app shutdown). Cards are hidden-not-closed on dismiss so
// they can be reused, but a hidden window still counts as "open" to Electron - left alive it
// blocks 'window-all-closed' and the app never quits with the main window.
function destroy() {
  if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
  clearPendingHide('card');
  clearPendingHide('board');
  if (boundsSaveTimer) { clearTimeout(boundsSaveTimer); boundsSaveTimer = null; }
  pending = null;
  currentId = 0;
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (_e) {}
  win = null;
  try { if (boardWin && !boardWin.isDestroyed()) boardWin.destroy(); } catch (_e) {}
  boardWin = null;
  publishSlots();
}

module.exports = { normalizePayload, resolveAccent, mapIcon, ACCENTS, SCENES, init, open, scrollTo, dismiss, notifyFaded, isOpen, destroy };
