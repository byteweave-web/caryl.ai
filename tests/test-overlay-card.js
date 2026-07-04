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

// --- board model: normalizePayload v2 ---
function boardFixture() {
  return {
    kind: 'forecast', title: 'Beirut, LB', accent: 'sky', scene: 'storm',
    current: { temp: 28.4, hi: 30, lo: 22, icon: '11d', condition: 'Thunderstorm',
      feelsLike: 29, humidity: 67, dewPoint: 21, pressure: 1007, visibility: 21,
      wind: { speed: 23, gust: 37, deg: 241 }, sunrise: '05:30', sunset: '19:52',
      isNight: false, moon: { phase: 'waning-gibbous', illumination: 82 } },
    hourly: Array.from({ length: 8 }, (_, i) => ({ time: i + ':00', temp: 20 + i, icon: '10d', condition: 'Rain', pop: 40 })),
    daily: Array.from({ length: 5 }, (_, i) => ({ day: i ? 'Sun' : 'Today', icon: '01d', lo: 20, hi: 30, pop: 10 })),
    narration: [{ text: 'a', tile: 0 }, { text: 'b', tile: 7 }]
  };
}
let bm = overlay.normalizePayload(boardFixture());
assert.strictEqual(bm.kind, 'forecast');
assert.strictEqual(bm.scene, 'storm');
assert.strictEqual(bm.current.temp, 28, 'temps rounded');
assert.strictEqual(bm.current.icon, 'thunder', 'icons mapped to sprite ids');
assert.strictEqual(bm.hourly[0].icon, 'rain');
assert.strictEqual(bm.daily[0].icon, 'sun');
assert.strictEqual(bm.current.wind.deg, 241);
assert.strictEqual(bm.current.moon.phase, 'waning-gibbous');
assert.strictEqual(bm.daily.length, 5);

bm = overlay.normalizePayload(Object.assign(boardFixture(), { scene: 'volcano' }));
assert.strictEqual(bm.scene, 'clouds', 'unknown scene -> clouds');

bm = overlay.normalizePayload(Object.assign(boardFixture(), { daily: [{ day: 'Today', icon: '01d', lo: 1, hi: 2, pop: 0 }] }));
assert.strictEqual(bm.kind, 'rows', '<2 daily rows demotes');

bm = overlay.normalizePayload(Object.assign(boardFixture(), { hourly: [] }));
assert.strictEqual(bm.kind, 'rows', 'empty hourly demotes');

bm = overlay.normalizePayload(Object.assign(boardFixture(), { current: null }));
assert.strictEqual(bm.kind, 'forecast', 'missing current tolerated (renderer shows dashes)');
assert.ok(bm.current && typeof bm.current === 'object');

bm = overlay.normalizePayload(Object.assign(boardFixture(), {
  daily: Array.from({ length: 9 }, () => ({ day: 'X', icon: '01d', lo: 1, hi: 2, pop: 0 }))
}));
assert.strictEqual(bm.daily.length, 6, 'daily capped at 6');

console.log('test-overlay-card: all assertions passed');
