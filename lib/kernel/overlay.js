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

// OpenWeather icon code (01d..50n) -> our inline SVG sprite id. Default: cloud.
function mapIcon(code) {
  const c = String(code || '');
  if (c.startsWith('01')) return c.endsWith('n') ? 'moon' : 'sun';
  if (c.startsWith('02')) return 'partly';
  if (c.startsWith('03') || c.startsWith('04')) return 'cloud';
  if (c.startsWith('09')) return 'drizzle';
  if (c.startsWith('10')) return 'rain';
  if (c.startsWith('11')) return 'thunder';
  if (c.startsWith('13')) return 'snow';
  if (c.startsWith('50')) return 'mist';
  return 'cloud';
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

let win = null;             // the one card BrowserWindow
let cardSeq = 0;            // monotonic id; stale scrollTo/dismiss calls are ignored
let currentId = 0;          // id of the card currently showing (0 = none)
let safetyTimer = null;
let hideFallbackTimer = null; // cleared by notifyFaded()/open(); see dismiss() below
const SAFETY_MS = 30000;    // force-dismiss if no speech-end ever arrives
// Normal hide arrives via the renderer's card:faded ack (sent once its fade-out transition
// finishes). This fallback only fires if that ack is ever lost (e.g. renderer crashed mid-fade),
// so it's generous rather than tight - a real ack always beats it in practice.
const HIDE_FALLBACK_MS = 60000;

// Latest requested card while a window is still loading (createWin -> did-finish-load).
// { model, width, height, id } | null. Consumed (and nulled) by renderPending().
let pending = null;

// deps injected by main.js at first use: { preloadPath, shellStyle }
let deps = null;
function init(d) { deps = d; }

function sizeFor(model) {
  if (model.kind === 'forecast') return { width: 440, height: 268 };
  return { width: 340, height: Math.min(420, 128 + 38 * Math.max(1, model.rows.length)) };
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
  win.on('closed', () => { win = null; currentId = 0; });
  return win;
}

function send(channel, arg) {
  if (win && !win.isDestroyed()) { try { win.webContents.send(channel, arg); } catch (_e) {} }
}

// Consumes `pending` (the latest requested card) and actually renders it. Bound to
// did-finish-load on first create; called directly by open() once the window is ready.
// Always renders the NEWEST pending model - a second open() that arrived while the window
// was still loading overwrites `pending` rather than firing its own (dropped) send().
function renderPending() {
  if (!pending || pending.id !== currentId || !win || win.isDestroyed()) return;
  const { model, width, height } = pending;
  pending = null;
  const { screen } = electron();
  const wa = screen.getPrimaryDisplay().workArea;
  win.setBounds({ x: wa.x + Math.round((wa.width - width) / 2), y: wa.y + Math.round((wa.height - height) / 2), width, height });
  send('card:render', model);
  win.showInactive();
}

// Show a card. Returns its id (pass it to scrollTo/dismiss to guard against staleness).
function open(payload) {
  if (!deps) return 0;
  const model = normalizePayload(payload);
  model.accentColors = resolveAccent(model.accent); // concrete colors ride the payload
  const id = ++cardSeq;
  currentId = id;
  const { width, height } = sizeFor(model);
  pending = { model, width, height, id };

  // A new card supersedes any pending hide from a just-dismissed one.
  if (hideFallbackTimer) { clearTimeout(hideFallbackTimer); hideFallbackTimer = null; }

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
  return id;
}

function scrollTo(index, cardId) {
  if (cardId && cardId !== currentId) return; // stale narration event
  send('card:scrollTo', index);
}

function dismiss(reason, cardId) {
  if (cardId && cardId !== currentId) return; // stale (a newer card is up)
  if (!win || win.isDestroyed() || currentId === 0) return;
  currentId = 0;
  if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
  send('card:dismiss', reason);
  // The renderer acks with card:faded once its fade-out transition actually completes (see
  // notifyFaded() below); this fallback only hides us if that ack is ever lost.
  if (hideFallbackTimer) clearTimeout(hideFallbackTimer);
  hideFallbackTimer = setTimeout(() => {
    hideFallbackTimer = null;
    if (win && !win.isDestroyed() && currentId === 0) win.hide();
  }, HIDE_FALLBACK_MS);
}

// Called on the renderer's card:faded ack (its fade-out transition finished). Hides the window
// immediately unless a newer card has since taken over (currentId !== 0).
function notifyFaded() {
  if (hideFallbackTimer) { clearTimeout(hideFallbackTimer); hideFallbackTimer = null; }
  if (currentId === 0 && win && !win.isDestroyed()) win.hide();
}

function isOpen() { return currentId !== 0 && !!win && !win.isDestroyed() && win.isVisible(); }

// Tear the card window down for real (app shutdown). The card is hidden-not-closed on
// dismiss so it can be reused, but a hidden window still counts as "open" to Electron -
// left alive it blocks 'window-all-closed' and the app never quits with the main window.
function destroy() {
  if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
  if (hideFallbackTimer) { clearTimeout(hideFallbackTimer); hideFallbackTimer = null; }
  pending = null;
  currentId = 0;
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (_e) {}
  win = null;
}

module.exports = { normalizePayload, resolveAccent, mapIcon, ACCENTS, SCENES, init, open, scrollTo, dismiss, notifyFaded, isOpen, destroy };
