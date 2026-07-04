// tests/test-overlay-card.js
// Pure tests for the overlay card's payload normalization, accent palette, and icon map.
// Plain node + assert, no framework. The Electron window shell is NOT tested here.
const assert = require('assert');
const overlay = require('../lib/kernel/overlay');

// --- resolveAccent: known semantic names -> colors; unknown -> null (theme fallback) ---
const sky = overlay.resolveAccent('sky');
assert.ok(sky && /^#/.test(sky.accent) && /rgba\(/.test(sky.soft), 'sky maps to a color pair');
assert.ok(overlay.resolveAccent('blue'), 'blue is a known accent');
assert.strictEqual(overlay.resolveAccent('hotpink'), null, 'unknown accent -> null');
assert.strictEqual(overlay.resolveAccent(''), null, 'empty accent -> null');
assert.strictEqual(overlay.resolveAccent(undefined), null, 'missing accent -> null');

// --- mapIcon: OpenWeather codes -> sprite ids ---
assert.strictEqual(overlay.mapIcon('01d'), 'sun');
assert.strictEqual(overlay.mapIcon('01n'), 'moon');
assert.strictEqual(overlay.mapIcon('02d'), 'partly');
assert.strictEqual(overlay.mapIcon('02n'), 'partly');
assert.strictEqual(overlay.mapIcon('03d'), 'cloud');
assert.strictEqual(overlay.mapIcon('04n'), 'cloud');
assert.strictEqual(overlay.mapIcon('09d'), 'drizzle');
assert.strictEqual(overlay.mapIcon('10n'), 'rain');
assert.strictEqual(overlay.mapIcon('11d'), 'thunder');
assert.strictEqual(overlay.mapIcon('13d'), 'snow');
assert.strictEqual(overlay.mapIcon('50d'), 'mist');
assert.strictEqual(overlay.mapIcon('99x'), 'cloud', 'unknown code -> cloud default');
assert.strictEqual(overlay.mapIcon(''), 'cloud', 'empty code -> cloud default');

// --- normalizePayload: rows kind ---
let p = overlay.normalizePayload({ title: 'System stats', accent: 'blue', rows: [{ label: 'CPU', value: '8 x Test' }] });
assert.strictEqual(p.kind, 'rows', 'no kind -> rows');
assert.strictEqual(p.title, 'System stats');
assert.deepStrictEqual(p.rows[0], { label: 'CPU', value: '8 x Test' });

// junk coercion: non-string labels/values become strings, junk rows dropped
p = overlay.normalizePayload({ rows: [{ label: 42, value: null }, 'junk', { label: 'ok', value: 'v' }] });
assert.strictEqual(p.kind, 'rows');
assert.strictEqual(typeof p.rows[0].label, 'string');
assert.strictEqual(typeof p.rows[0].value, 'string');
assert.strictEqual(p.rows.length, 2, 'non-object row entries are dropped');
assert.ok(p.title, 'missing title gets a non-empty default');

// caps: rows hard-capped at 12
p = overlay.normalizePayload({ rows: Array.from({ length: 20 }, (_, i) => ({ label: 'L' + i, value: 'v' })) });
assert.strictEqual(p.rows.length, 12, 'rows capped at 12');

// totally junk payloads never throw and always render *something*
assert.strictEqual(overlay.normalizePayload(null).kind, 'rows');
assert.strictEqual(overlay.normalizePayload(undefined).kind, 'rows');
assert.strictEqual(overlay.normalizePayload('weather').kind, 'rows');
assert.ok(Array.isArray(overlay.normalizePayload(null).rows));

// --- normalizePayload: forecast kind ---
const fc = {
  kind: 'forecast', title: 'Tokyo, JP', accent: 'sky',
  current: { temp: 24.4, icon: '01d', condition: 'Clear sky' },
  forecast: Array.from({ length: 8 }, (_, i) => ({ time: (9 + i * 3) % 24 + ':00', temp: 20 + i, icon: '02d', condition: 'Clouds' })),
  narration: [{ text: 'Right now 24.', tile: 0 }, { text: 'Later 27.', tile: 7 }]
};
p = overlay.normalizePayload(fc);
assert.strictEqual(p.kind, 'forecast');
assert.strictEqual(p.forecast.length, 8);
assert.strictEqual(p.current.temp, 24, 'temps rounded to integers');
assert.strictEqual(p.narration.length, 2);
assert.strictEqual(p.narration[1].tile, 7);

// forecast tiles capped at 8
p = overlay.normalizePayload(Object.assign({}, fc, { forecast: Array.from({ length: 12 }, () => ({ time: '09:00', temp: 20, icon: '01d', condition: 'Clear' })) }));
assert.strictEqual(p.forecast.length, 8, 'tiles capped at 8');

// narration tile indices out of range are clamped into [0, tiles-1]
p = overlay.normalizePayload(Object.assign({}, fc, { narration: [{ text: 'x', tile: 99 }, { text: 'y', tile: -3 }] }));
assert.strictEqual(p.narration[0].tile, 7);
assert.strictEqual(p.narration[1].tile, 0);

// forecast kind with an empty/missing forecast[] demotes to rows (never a dead card)
p = overlay.normalizePayload({ kind: 'forecast', title: 'Tokyo', forecast: [] });
assert.strictEqual(p.kind, 'rows', 'empty forecast demotes to rows');
p = overlay.normalizePayload({ kind: 'forecast', title: 'Tokyo' });
assert.strictEqual(p.kind, 'rows', 'missing forecast demotes to rows');

console.log('test-overlay-card: all assertions passed');
