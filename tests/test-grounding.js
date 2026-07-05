// tests/test-grounding.js
// Pure tests for grounding-box parsing + letterbox mapping. Plain node + assert.
const assert = require('assert');
const g = require('../lib/grounding');

function approx(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-9 : eps); }

// --- parseGroundingBox: clean normalized JSON ---
let r = g.parseGroundingBox('{"found":true,"label":"coffee mug","box":[0.1,0.2,0.5,0.6]}');
assert.strictEqual(r.found, true);
assert.strictEqual(r.label, 'coffee mug');
assert.deepStrictEqual(r.box, [0.1, 0.2, 0.5, 0.6]);

// fenced + surrounding prose
r = g.parseGroundingBox('Sure! ```json\n{"found":true,"label":"pen","box":[0.2,0.2,0.4,0.5]}\n``` hope that helps');
assert.strictEqual(r.found, true);
assert.strictEqual(r.label, 'pen');

// found:false
assert.strictEqual(g.parseGroundingBox('{"found":false}').found, false);

// Gemini box_2d order [ymin,xmin,ymax,xmax] at 0..1000 -> reordered + scaled
r = g.parseGroundingBox('{"label":"cup","box_2d":[200,100,600,500]}');
assert.strictEqual(r.found, true);
assert.ok(approx(r.box[0], 0.1) && approx(r.box[1], 0.2) && approx(r.box[2], 0.5) && approx(r.box[3], 0.6), 'box_2d reordered x1,y1,x2,y2 and /1000');

// named xmin/ymin/xmax/ymax
r = g.parseGroundingBox('{"label":"book","xmin":0.1,"ymin":0.1,"xmax":0.3,"ymax":0.4}');
assert.deepStrictEqual(r.box, [0.1, 0.1, 0.3, 0.4]);

// left/top/right/bottom
r = g.parseGroundingBox('{"name":"phone","left":0.5,"top":0.5,"right":0.9,"bottom":0.8}');
assert.strictEqual(r.label, 'phone');
assert.deepStrictEqual(r.box, [0.5, 0.5, 0.9, 0.8]);

// values >1 with no imgDims -> /1000
r = g.parseGroundingBox('{"found":true,"label":"x","box":[100,200,500,600]}');
assert.ok(approx(r.box[0], 0.1) && approx(r.box[2], 0.5));

// pixel coords with imgDims
r = g.parseGroundingBox('{"found":true,"label":"x","box":[64,96,320,240]}', { w: 640, h: 480 });
assert.ok(approx(r.box[0], 0.1) && approx(r.box[1], 0.2) && approx(r.box[2], 0.5) && approx(r.box[3], 0.5));

// reversed corners get ordered; out-of-range clamped
r = g.parseGroundingBox('{"found":true,"label":"x","box":[0.6,0.6,0.2,0.2]}');
assert.deepStrictEqual(r.box, [0.2, 0.2, 0.6, 0.6]);
r = g.parseGroundingBox('{"found":true,"label":"x","box":[-0.2,-0.1,1.4,1.2]}');
assert.deepStrictEqual(r.box, [0, 0, 1, 1]);

// degenerate / zero-area -> not found
assert.strictEqual(g.parseGroundingBox('{"found":true,"label":"x","box":[0.5,0.5,0.5,0.5]}').found, false);

// junk / empty / non-json -> not found, never throws
assert.strictEqual(g.parseGroundingBox('I could not find it').found, false);
assert.strictEqual(g.parseGroundingBox('').found, false);
assert.strictEqual(g.parseGroundingBox(null).found, false);
assert.strictEqual(g.parseGroundingBox('{"box":"nope"}').found, false);
assert.strictEqual(g.parseGroundingBox('{"box":[1,2,3]}').found, false, 'need 4 numbers');

// --- mapBoxToCanvas: letterbox math ---
// exact fit (no letterbox)
let m = g.mapBoxToCanvas([0.1, 0.2, 0.5, 0.6], { vw: 100, vh: 100 }, { cw: 100, ch: 100 });
assert.ok(approx(m.x, 10) && approx(m.y, 20) && approx(m.w, 40) && approx(m.h, 40));
// pillarbox: 100x100 video into 200x100 canvas -> centered, offsetX 50
m = g.mapBoxToCanvas([0, 0, 1, 1], { vw: 100, vh: 100 }, { cw: 200, ch: 100 });
assert.ok(approx(m.x, 50) && approx(m.y, 0) && approx(m.w, 100) && approx(m.h, 100));
// letterbox: 100x100 into 100x200 -> offsetY 50
m = g.mapBoxToCanvas([0, 0, 1, 1], { vw: 100, vh: 100 }, { cw: 100, ch: 200 });
assert.ok(approx(m.x, 0) && approx(m.y, 50) && approx(m.w, 100) && approx(m.h, 100));
// degenerate video dims -> zeros, no NaN
m = g.mapBoxToCanvas([0, 0, 1, 1], { vw: 0, vh: 0 }, { cw: 100, ch: 100 });
assert.ok(isFinite(m.x) && isFinite(m.w));

// --- iou: normalized-box intersection over union ---
assert.strictEqual(g.iou([0, 0, 1, 1], [0, 0, 1, 1]), 1, 'identical -> 1');
assert.strictEqual(g.iou([0, 0, 0.5, 1], [0.5, 0, 1, 1]), 0, 'touching, no overlap -> 0');
assert.strictEqual(g.iou([0, 0, 1, 1], [2, 2, 3, 3]), 0, 'disjoint -> 0');
// half-overlap: A[0,0,1,1] area1, B[0.5,0,1.5,1] -> inter=0.5, union=1+1-0.5=1.5 -> 1/3
assert.ok(approx(g.iou([0, 0, 1, 1], [0.5, 0, 1.5, 1]), 1 / 3), 'partial overlap iou');
assert.strictEqual(g.iou(null, [0, 0, 1, 1]), 0, 'null-safe');

// --- pickBestBox: the candidate most overlapping the seed, above a min IoU, else null ---
const cands = [[0, 0, 0.2, 0.2], [0.45, 0.45, 0.95, 0.95], [0.8, 0.8, 1, 1]];
let best = g.pickBestBox(cands, [0.5, 0.5, 1, 1], 0.1);
assert.deepStrictEqual(best, [0.45, 0.45, 0.95, 0.95], 'picks the overlapping candidate');
assert.strictEqual(g.pickBestBox(cands, [0.5, 0.5, 0.52, 0.52], 0.3), null, 'nothing above min IoU -> null');
assert.strictEqual(g.pickBestBox([], [0, 0, 1, 1], 0.1), null, 'no candidates -> null');
assert.strictEqual(g.pickBestBox(null, [0, 0, 1, 1], 0.1), null, 'null candidates -> null');

console.log('test-grounding: all assertions passed');
