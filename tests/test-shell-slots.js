// tests/test-shell-slots.js
// Pure tests for satellite -> corner-slot occupancy (lib/shell-slots.js). node + assert.
const assert = require('assert');
const S = require('../lib/shell-slots');

const MAIN = { x: 0, y: 0, width: 1600, height: 900 };

// corner regions: sized by REGION (380x280), top pair inset 64px below the topbar
let r = S.cornerRegions(MAIN);
assert.deepStrictEqual(r.TL, { x: 0, y: 64, width: 380, height: 280 }, 'TL region');
assert.deepStrictEqual(r.BR, { x: 1220, y: 620, width: 380, height: 280 }, 'BR region');
assert.deepStrictEqual(r.CENTER, { x: 400, y: 225, width: 800, height: 450 }, 'CENTER region');

// ratio boundary: BR region area = 380*280 = 106400; 25% = 26600 = 190x140
let sat = { x: 1600 - 190, y: 900 - 140, width: 400, height: 400 };
assert.deepStrictEqual(S.occupiedSlots(MAIN, [sat]), ['BR'], 'exact 25% occupies BR');
sat = { x: 1600 - 189, y: 900 - 140, width: 400, height: 400 };
assert.deepStrictEqual(S.occupiedSlots(MAIN, [sat]), [], 'just under 25% leaves BR free');

// the default centered weather board (65% of the work area) covers CENTER, not the corners
const board = { x: 280, y: 158, width: 1040, height: 585 };
assert.deepStrictEqual(S.occupiedSlots(MAIN, [board]), ['CENTER'], 'centered board -> CENTER only');

// a full-cover satellite occupies all five
assert.deepStrictEqual(S.occupiedSlots(MAIN, [MAIN]).sort(),
  ['BL', 'BR', 'CENTER', 'TL', 'TR'], 'full cover -> everything');

// no overlap (other monitor) -> nothing
assert.deepStrictEqual(S.occupiedSlots(MAIN, [{ x: 2000, y: 0, width: 500, height: 500 }]), [],
  'off-shell satellite -> all free');

// computePublish: classification + main-window detection
const wins = [
  { url: 'file:///C:/app/renderer/index.html', bounds: MAIN, visible: true },
  { url: 'file:///C:/app/renderer/weather-board.html?x=1', bounds: board, visible: true },
  { url: 'file:///C:/app/renderer/unknown.html', bounds: board, visible: true },
  { url: 'file:///C:/app/renderer/overlay-card.html', bounds: { x: 0, y: 0, width: 10, height: 10 }, visible: false },
];
let p = S.computePublish(wins);
assert.deepStrictEqual(p, { slots: ['CENTER'], sats: ['weather'] }, 'classify + ignore unknown/invisible');

// no main window -> null (publish becomes a no-op)
assert.strictEqual(S.computePublish(wins.slice(1)), null, 'no main -> null');

// pageOf handles query strings and hashes
assert.strictEqual(S.pageOf('file:///a/b/weather-board.html?embed=1#x'), 'weather-board.html');

console.log('test-shell-slots: OK');
