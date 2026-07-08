// lib/shell-slots.js
// Satellite occupancy for the Unified OS slot allocator (spec Phase 5): which corners of
// the MAIN window are physically covered by satellite windows (weather board, overlay
// card, bubble, HUD panel)? Pure geometry + classification up top (node-tested, zero
// Electron); the thin publish() glue at the bottom broadcasts `shell:satellites` to the
// main renderer, and hooks the involved windows so future moves re-publish themselves.
'use strict';

// Renderer page -> satellite name. Anything else (devtools, unknown pages) is ignored.
const PAGES = {
  'weather-board.html': 'weather',
  'overlay-card.html': 'card',
  'mini-overlay.html': 'mini',
  'overlay.html': 'overlay',
  'research-overlay.html': 'research',
};
const MAIN_PAGE = 'index.html';

const REGION = { w: 380, h: 280, topInset: 64 }; // corner probe boxes (topbar-aware)
const RATIO = 0.25;                              // >= this coverage occupies the slot

function pageOf(url) {
  const m = /\/([^\/?#]+\.html)(?:[?#]|$)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : '';
}

function cornerRegions(main, opt) {
  const o = Object.assign({}, REGION, opt || {});
  const w = Math.min(o.w, main.width), h = Math.min(o.h, main.height);
  const top = main.y + o.topInset;
  return {
    TL: { x: main.x, y: top, width: w, height: h },
    TR: { x: main.x + main.width - w, y: top, width: w, height: h },
    BL: { x: main.x, y: main.y + main.height - h, width: w, height: h },
    BR: { x: main.x + main.width - w, y: main.y + main.height - h, width: w, height: h },
    CENTER: {
      x: main.x + Math.round(main.width * .25), y: main.y + Math.round(main.height * .25),
      width: Math.round(main.width * .5), height: Math.round(main.height * .5),
    },
  };
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// A slot is occupied when ANY satellite rect covers >= ratio of its region's area.
function occupiedSlots(main, satRects, opt) {
  const o = opt || {};
  const ratio = typeof o.ratio === 'number' ? o.ratio : RATIO;
  const regions = cornerRegions(main, o);
  const out = [];
  Object.keys(regions).forEach((slot) => {
    const region = regions[slot];
    const area = region.width * region.height;
    if (area <= 0) return;
    const covered = (satRects || []).some((s) => s && overlapArea(region, s) / area >= ratio);
    if (covered) out.push(slot);
  });
  return out;
}

// wins: [{url, bounds, visible}] -> { slots, sats } | null when no main window is found.
function computePublish(wins) {
  let main = null;
  const sats = [];
  (wins || []).forEach((w) => {
    if (!w || !w.visible) return;
    const page = pageOf(w.url);
    if (page === MAIN_PAGE) { main = w; return; }
    const name = PAGES[page];
    if (name) sats.push({ name, bounds: w.bounds });
  });
  if (!main || !main.bounds) return null;
  return {
    slots: occupiedSlots(main.bounds, sats.map((s) => s.bounds)),
    sats: sats.map((s) => s.name),
  };
}

// ---------------------------------------------------------------------------
// Electron glue. Everything below touches BrowserWindow; nothing above does.
// ---------------------------------------------------------------------------
const hooked = new WeakSet(); // windows whose geometry/visibility already re-publish
let timer = null;
let electronRef = null;

function snapshot(electron) {
  return electron.BrowserWindow.getAllWindows().map((w) => {
    try {
      return { url: w.webContents.getURL(), bounds: w.getBounds(), visible: w.isVisible(), _w: w };
    } catch (_e) { return null; }
  }).filter(Boolean);
}

// Broadcast current occupancy to the main renderer (debounced — show/hide/move bursts
// coalesce). Idempotently hooks every known window so future changes re-publish alone.
function publish(electron) {
  electronRef = electron || electronRef;
  if (!electronRef) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    let wins;
    try { wins = snapshot(electronRef); } catch (_e) { return; }
    const payload = computePublish(wins);
    wins.forEach((w) => {
      const page = pageOf(w.url);
      if (page !== MAIN_PAGE && !PAGES[page]) return;
      if (!hooked.has(w._w)) {
        hooked.add(w._w);
        ['move', 'resize', 'show', 'hide', 'closed', 'minimize', 'restore'].forEach((ev) => {
          try { w._w.on(ev, () => publish(electronRef)); } catch (_e) {}
        });
      }
      if (payload && page === MAIN_PAGE) {
        try { w._w.webContents.send('shell:satellites', payload); } catch (_e) {}
      }
    });
  }, 150);
}

module.exports = {
  PAGES, MAIN_PAGE, REGION, RATIO,
  pageOf, cornerRegions, overlapArea, occupiedSlots, computePublish, publish,
};
