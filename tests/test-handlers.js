// tests/test-handlers.js
// Pure-logic tests for the Kernel's PURE_LOGIC handlers (math, systemStats).
// Plain node + assert, no framework.
const assert = require('assert');
const math = require('../lib/kernel/handlers/math');
const sys = require('../lib/kernel/handlers/systemStats');

// --- math: arithmetic, precedence, parens ---
assert.strictEqual(math.evaluate('2 + 3').value, 5);
assert.strictEqual(math.evaluate('2 + 3 * 4').value, 14, 'multiplication binds tighter');
assert.strictEqual(math.evaluate('(2 + 3) * 4').value, 20, 'parentheses override precedence');
assert.strictEqual(math.evaluate('10 / 4').value, 2.5);
assert.strictEqual(math.evaluate('2 - 3 - 4').value, -5, 'subtraction is left-associative');

// modulo (the % operator between two numbers)
assert.strictEqual(math.evaluate('10 % 3').value, 1);

// unary minus
assert.strictEqual(math.evaluate('-5 + 2').value, -3);
assert.strictEqual(math.evaluate('2 * -3').value, -6);
assert.strictEqual(math.evaluate('-(3 + 4)').value, -7);

// decimals (float-tolerant)
assert.ok(Math.abs(math.evaluate('0.1 + 0.2').value - 0.3) < 1e-9);

// percentages: "X% of Y" and standalone "X%"
assert.strictEqual(math.evaluate('12.5% of 340').value, 42.5);
assert.strictEqual(math.evaluate('50%').value, 0.5);

// ok flag + clean formatting
let r = math.evaluate('2 + 2');
assert.strictEqual(r.ok, true);
assert.strictEqual(r.formatted, '4', 'integer results have no decimal point');
assert.strictEqual(math.evaluate('1 / 3').formatted, '0.333333', 'repeating decimals are trimmed');

// errors: malformed / empty / divide-by-zero / anything that looks like code
assert.strictEqual(math.evaluate('2 +').ok, false, 'dangling operator');
assert.strictEqual(math.evaluate('').ok, false, 'empty input');
assert.strictEqual(math.evaluate('2 / 0').ok, false, 'division by zero is an error, not Infinity');
assert.strictEqual(math.evaluate('process.exit(1)').ok, false, 'no code execution');
assert.strictEqual(math.evaluate('alert(1)').ok, false, 'no code execution');
assert.strictEqual(math.evaluate('2; 3').ok, false, 'no statement separators');

// run() wrapper -> spoken result
r = math.run({ expression: '12.5% of 340' });
assert.strictEqual(r.ok, true);
assert.ok(/42\.5/.test(r.speak), 'spoken answer includes the result');
assert.strictEqual(math.run({}).ok, false, 'missing expression -> error, never throws');

// --- systemStats: pure formatters ---
assert.strictEqual(sys.formatBytes(0), '0 B');
assert.strictEqual(sys.formatBytes(512), '512 B');
assert.strictEqual(sys.formatBytes(1023), '1023 B');
assert.strictEqual(sys.formatBytes(1024), '1.0 KB');
assert.strictEqual(sys.formatBytes(1536), '1.5 KB');
assert.strictEqual(sys.formatBytes(8 * 1024 * 1024 * 1024), '8.0 GB');

assert.strictEqual(sys.formatUptime(45), '45s');
assert.strictEqual(sys.formatUptime(90), '1m 30s');
assert.strictEqual(sys.formatUptime(3661), '1h 1m');
assert.strictEqual(sys.formatUptime(90000), '1d 1h');

// --- systemStats: buildPayload is a pure function of raw readings ---
function rowVal(payload, label) {
  const row = payload.rows.find((x) => x.label === label);
  return row ? row.value : null;
}
const raw = {
  totalMem: 16 * 1024 * 1024 * 1024,
  freeMem: 8 * 1024 * 1024 * 1024,
  cpuCount: 8,
  cpuModel: 'Test CPU',
  uptimeSec: 3661,
  platform: 'win32',
  release: '10.0.26200'
};
let p = sys.buildPayload(raw);
assert.ok(p && typeof p.title === 'string' && p.title, 'payload has a title');
assert.ok(Array.isArray(p.rows) && p.rows.length > 0, 'payload has rows');
assert.ok(typeof p.accent === 'string', 'payload has an accent for the overlay');
assert.strictEqual(rowVal(p, 'Memory'), '8.0 GB / 16.0 GB (50%)');
assert.ok(/8/.test(rowVal(p, 'CPU')) && /Test CPU/.test(rowVal(p, 'CPU')));
assert.strictEqual(rowVal(p, 'Uptime'), '1h 1m');

// a Disk row appears only when disk readings are provided
assert.strictEqual(rowVal(p, 'Disk'), null, 'no Disk row without disk data');
p = sys.buildPayload(Object.assign({}, raw, { disk: { total: 500 * 1024 * 1024 * 1024, free: 100 * 1024 * 1024 * 1024 } }));
assert.ok(/80%/.test(rowVal(p, 'Disk')), 'Disk row shows used percentage');

// --- systemStats: collect()/run() smoke test on the real machine (shape only) ---
const live = sys.collect();
assert.ok(live && typeof live.title === 'string');
assert.ok(Array.isArray(live.rows) && live.rows.length > 0, 'collect() returns real rows');
const rr = sys.run({});
assert.strictEqual(rr.ok, true);
assert.ok(typeof rr.speak === 'string' && rr.speak.length > 0);
assert.ok(rr.overlay && Array.isArray(rr.overlay.rows), 'run() carries the overlay payload');

console.log('test-handlers: all assertions passed');
