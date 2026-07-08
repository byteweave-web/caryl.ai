// lib/grounding.js
// Pure helpers for camera object focus (D2). No Electron/DOM: node-tested and exposed to the
// renderer via preload.js. parseGroundingBox turns an untrusted vision answer into a
// normalized box (or found:false); mapBoxToCanvas maps that box onto the letterboxed video.

function toNum(v) { const n = Number(v); return isFinite(n) ? n : null; }

// Pull the first balanced JSON object out of a raw model answer (may be fenced / prose-wrapped).
function extractJson(raw) {
  const s = String(raw == null ? '' : raw);
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch (_e) { return null; } } }
  }
  return null;
}

// Extract 4 corner numbers in [x1,y1,x2,y2] source order using key/shape heuristics, or null.
function fourFrom(obj) {
  const n = toNum, h = (k) => obj[k] !== undefined;
  if (h('x1') && h('y1') && h('x2') && h('y2')) return [n(obj.x1), n(obj.y1), n(obj.x2), n(obj.y2)];
  if (h('xmin') && h('ymin') && h('xmax') && h('ymax')) return [n(obj.xmin), n(obj.ymin), n(obj.xmax), n(obj.ymax)];
  if (h('left') && h('top') && h('right') && h('bottom')) return [n(obj.left), n(obj.top), n(obj.right), n(obj.bottom)];
  if (Array.isArray(obj.box_2d) && obj.box_2d.length >= 4) { const b = obj.box_2d.map(n); return [b[1], b[0], b[3], b[2]]; } // Gemini [ymin,xmin,ymax,xmax]
  const arr = Array.isArray(obj.box) ? obj.box : Array.isArray(obj.bbox) ? obj.bbox : Array.isArray(obj.boundingBox) ? obj.boundingBox : null;
  if (arr && arr.length >= 4) { const b = arr.map(n); return [b[0], b[1], b[2], b[3]]; }
  return null;
}

function parseGroundingBox(raw, imgDims) {
  const obj = extractJson(raw);
  if (!obj || typeof obj !== 'object') return { found: false };
  if (obj.found === false) return { found: false };
  const four = fourFrom(obj);
  if (!four || four.some((v) => v == null)) return { found: false };
  let [x1, y1, x2, y2] = four;
  // Scale only when coords are clearly not normalized (0..1000 or pixels: values in the tens+).
  // Coords a hair over 1 are normalized-with-overflow and should just clamp, not get /1000.
  const maxv = Math.max(x1, y1, x2, y2);
  if (maxv > 1.5) {
    if (imgDims && imgDims.w > 0 && imgDims.h > 0) { x1 /= imgDims.w; x2 /= imgDims.w; y1 /= imgDims.h; y2 /= imgDims.h; }
    else { x1 /= 1000; y1 /= 1000; x2 /= 1000; y2 /= 1000; }
  }
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const bx1 = clamp(Math.min(x1, x2)), bx2 = clamp(Math.max(x1, x2));
  const by1 = clamp(Math.min(y1, y2)), by2 = clamp(Math.max(y1, y2));
  if (bx2 - bx1 < 0.005 || by2 - by1 < 0.005) return { found: false };
  const label = String(obj.label || obj.name || obj.object || obj.class || '').trim();
  return { found: true, label, box: [bx1, by1, bx2, by2] };
}

// Normalized box + native video dims + displayed-canvas dims -> pixel rect, accounting for
// object-fit: contain letterboxing (video centered in the canvas/stage).
function mapBoxToCanvas(box, video, canvas) {
  const b = Array.isArray(box) ? box : [0, 0, 0, 0];
  const vw = (video && video.vw) || 0, vh = (video && video.vh) || 0;
  const cw = (canvas && canvas.cw) || 0, ch = (canvas && canvas.ch) || 0;
  if (vw <= 0 || vh <= 0 || cw <= 0 || ch <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const scale = Math.min(cw / vw, ch / vh);
  const dispW = vw * scale, dispH = vh * scale;
  const offX = (cw - dispW) / 2, offY = (ch - dispH) / 2;
  return { x: offX + b[0] * dispW, y: offY + b[1] * dispH, w: (b[2] - b[0]) * dispW, h: (b[3] - b[1]) * dispH };
}

// Intersection-over-union of two normalized boxes [x1,y1,x2,y2]. 0 when either is missing.
function iou(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const ix1 = Math.max(a[0], b[0]), iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]), iy2 = Math.min(a[3], b[3]);
  const iw = ix2 - ix1, ih = iy2 - iy1;
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

// Of the candidate boxes, the one most overlapping `seed` (frame-to-frame continuity /
// initial seed match), provided its IoU >= minIou; otherwise null (target lost this frame).
function pickBestBox(cands, seed, minIou) {
  if (!Array.isArray(cands) || !cands.length || !Array.isArray(seed)) return null;
  const min = (typeof minIou === 'number') ? minIou : 0.1;
  let best = null, bestScore = min;
  for (const c of cands) {
    const s = iou(c, seed);
    if (s >= bestScore) { bestScore = s; best = c; }
  }
  return best;
}

// Center distance (in normalized 0..1 units) between two boxes' centers, for snap-detection.
function _boxCenterDist(a, b) {
  const ax = (a[0] + a[2]) / 2, ay = (a[1] + a[3]) / 2;
  const bx = (b[0] + b[2]) / 2, by = (b[1] + b[3]) / 2;
  return Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
}

// Temporal-smoothing helper for the live-tracking loop. COCO-SSD's per-frame box hops a few
// px even on a perfectly still object (the detector's own jitter), and easings past 0.55 look
// laggy at the ~8fps detect rate. Supplies a single EMA per corner, BUT also snaps instantly
// when the new center moved > `snapDist` of the image away in one step - otherwise a tiny
// visible "swoop across the screen" between locks is what the user sees, not stability.
//   curr   : previous normalized box [x1,y1,x2,y2] (the on-screen one)
//   next   : newly-detected normalized box [x1,y1,x2,y2]
//   alpha  : weight on `next` (0.05 = very sticky, 0.6 = responsive). 0.4 is a sweet spot.
//   snapDist: hard-snap threshold in normalized units (default 0.3 = 30% of frame).
// Returns either a fresh array (so the caller's `curr` stays untouched) or the same shape.
function smoothBox(curr, next, alpha, snapDist) {
  if (!Array.isArray(curr) || curr.length < 4) return Array.isArray(next) ? next.slice() : null;
  if (!Array.isArray(next) || next.length < 4) return curr.slice();
  const a = (typeof alpha === 'number') ? Math.max(0, Math.min(1, alpha)) : 0.4;
  const sd = (typeof snapDist === 'number') ? snapDist : 0.3;
  if (_boxCenterDist(curr, next) > sd) return next.slice();        // huge jump -> snap, don't swoop
  const out = new Array(4);
  for (let i = 0; i < 4; i++) out[i] = curr[i] + a * (next[i] - curr[i]);
  return out;
}

module.exports = { parseGroundingBox, mapBoxToCanvas, iou, pickBestBox, smoothBox };
