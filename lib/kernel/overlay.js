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

module.exports = { normalizePayload, resolveAccent, mapIcon, ACCENTS };
