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
const MAX_TILES = 8;

function str(v, fallback) {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s || fallback;
}

// Any payload -> a safe render model the card can draw without ever seeing undefined.
// kind:'forecast' REQUIRES a non-empty forecast[]; anything else demotes to 'rows'.
function normalizePayload(p) {
  p = (p && typeof p === 'object') ? p : {};
  const title = str(p.title, 'Caryl');
  const accent = str(p.accent, '');

  const rows = (Array.isArray(p.rows) ? p.rows : [])
    .filter((r) => r && typeof r === 'object')
    .slice(0, MAX_ROWS)
    .map((r) => ({ label: str(r.label, ''), value: str(r.value, '') }));

  const tiles = (Array.isArray(p.forecast) ? p.forecast : [])
    .filter((t) => t && typeof t === 'object')
    .slice(0, MAX_TILES)
    .map((t) => ({
      time: str(t.time, '--:--'),
      temp: Math.round(Number(t.temp) || 0),
      icon: mapIcon(t.icon),
      condition: str(t.condition, '')
    }));

  if (p.kind === 'forecast' && tiles.length > 0) {
    const cur = (p.current && typeof p.current === 'object') ? p.current : {};
    const narration = (Array.isArray(p.narration) ? p.narration : [])
      .filter((n) => n && typeof n === 'object' && str(n.text, ''))
      .map((n) => ({
        text: str(n.text, ''),
        tile: Math.min(tiles.length - 1, Math.max(0, Number(n.tile) || 0))
      }));
    return {
      kind: 'forecast', title, accent, rows: [],
      current: {
        temp: Math.round(Number(cur.temp) || 0),
        icon: mapIcon(cur.icon),
        condition: str(cur.condition, '')
      },
      forecast: tiles, narration
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
const SAFETY_MS = 30000;    // force-dismiss if no speech-end ever arrives
const FADE_MS = 260;        // matches the renderer's leaving transition

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

// Show a card. Returns its id (pass it to scrollTo/dismiss to guard against staleness).
function open(payload) {
  if (!deps) return 0;
  const model = normalizePayload(payload);
  model.accentColors = resolveAccent(model.accent); // concrete colors ride the payload
  const id = ++cardSeq;
  currentId = id;
  const { width, height } = sizeFor(model);

  const show = () => {
    if (currentId !== id) return; // a newer card replaced us while loading
    const { screen } = electron();
    const wa = screen.getPrimaryDisplay().workArea;
    win.setBounds({ x: wa.x + Math.round((wa.width - width) / 2), y: wa.y + Math.round((wa.height - height) / 2), width, height });
    send('card:render', model);
    win.showInactive();
  };

  if (!win || win.isDestroyed()) {
    createWin(width, height);
    win.webContents.once('did-finish-load', show);
  } else {
    show();
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
  send('card:dismiss');
  setTimeout(() => { if (win && !win.isDestroyed() && currentId === 0) win.hide(); }, FADE_MS + 2200);
  // +2200: the renderer may hold the fade while hovered (pointer-leave grace). Hiding a bit
  // late is invisible (the card is already transparent); hiding early cuts the animation.
}

function isOpen() { return currentId !== 0 && !!win && !win.isDestroyed() && win.isVisible(); }

module.exports = { normalizePayload, resolveAccent, mapIcon, ACCENTS, init, open, scrollTo, dismiss, isOpen };
