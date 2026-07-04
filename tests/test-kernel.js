// tests/test-kernel.js
// Pure-logic tests for the Hybrid Automation Kernel core (router + registry).
// Plain node + assert, no framework — mirrors test-engines.js / test-migrate.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const router = require('../lib/kernel/router');
const registry = require('../lib/kernel/registry');
const { BUILTINS } = require('../lib/kernel');

// Sample registry snapshot (plain entry objects, as registry.all() would return).
const entries = [
  { id: 'weather.current', title: 'Weather', class: 'API_NATIVE',
    matchers: [ { type: 'keywords', all: ['weather'] } ],
    params: [ { name: 'location', required: false, extractor: 'after:in|for' } ] },
  { id: 'math.eval', title: 'Math', class: 'PURE_LOGIC',
    matchers: [ { type: 'regex', pattern: '\\d+\\s*[+\\-*/%]\\s*\\d+' } ],
    params: [] },
  { id: 'sys.stats', title: 'System stats', class: 'PURE_LOGIC',
    matchers: [ { type: 'keywords', all: ['system'], any: ['stats', 'status', 'cpu', 'ram', 'memory'] } ],
    params: [] }
];

// --- Cycle A: basic matching + no-match + threshold ---

// keyword match picks the right entry
let m = router.classify('what is the weather today', entries);
assert.ok(m, 'weather query should match');
assert.strictEqual(m.entry.id, 'weather.current');
assert.strictEqual(m.class, 'API_NATIVE');
assert.ok(m.confidence >= 0.5, 'confidence should clear the default threshold');

// regex match (math) picks the math entry
m = router.classify('compute 2 + 3 for me', entries);
assert.ok(m, 'math expression should match');
assert.strictEqual(m.entry.id, 'math.eval');

// no matcher hits -> null (falls through to the LLM path)
assert.strictEqual(router.classify('tell me a joke', entries), null);

// empty inputs -> null, never throw
assert.strictEqual(router.classify('', entries), null);
assert.strictEqual(router.classify('weather', []), null);

// more matched terms -> higher score; a stricter threshold rejects a weak single-term hit
m = router.classify('system cpu stats', entries);
assert.ok(m && m.entry.id === 'sys.stats');
assert.ok(m.confidence > 0.5, 'multi-term hit should score above a single-term hit');
assert.strictEqual(router.classify('system', entries, { threshold: 0.6 }), null,
  'a lone required-term hit (0.5) must be rejected by threshold 0.6');

// --- Cycle B: param extraction, needs, GUI-block flag, tie-break ---

// extractor pulls the location after "in"/"for"
m = router.classify('weather in Paris', entries);
assert.ok(m && m.entry.id === 'weather.current');
assert.strictEqual(m.params.location, 'Paris', 'location should be extracted with original case');

// GUI is hard-blocked for PURE_LOGIC / API_NATIVE matches
assert.strictEqual(router.classify('weather in Tokyo', entries).guiBlocked, true, 'API_NATIVE blocks GUI');
assert.strictEqual(router.classify('compute 2 + 2', entries).guiBlocked, true, 'PURE_LOGIC blocks GUI');

// HYBRID_UIA does NOT block the GUI (it IS a GUI task)
const uia = [ { id: 'app.open', title: 'Open app', class: 'HYBRID_UIA',
  matchers: [ { type: 'keywords', all: ['open'], any: ['notepad', 'app'] } ], params: [] } ];
m = router.classify('open notepad', uia);
assert.ok(m && m.entry.id === 'app.open');
assert.strictEqual(m.guiBlocked, false, 'HYBRID_UIA must not block the GUI');

// a required param that cannot be extracted is reported in `needs`
const strictWeather = [ { id: 'weather.current', class: 'API_NATIVE',
  matchers: [ { type: 'keywords', all: ['weather'] } ],
  params: [ { name: 'location', required: true, extractor: 'after:in|for' } ] } ];
m = router.classify('what is the weather', strictWeather);
assert.deepStrictEqual(m.needs, ['location'], 'missing required param should be listed in needs');
assert.strictEqual(m.params.location, null);
m = router.classify('weather in Berlin', strictWeather);
assert.deepStrictEqual(m.needs, [], 'no needs when the required param is present');
assert.strictEqual(m.params.location, 'Berlin');

// equal score -> higher successCount wins the tie
const tie = [
  { id: 'a', class: 'PURE_LOGIC', matchers: [ { type: 'keywords', all: ['foo'] } ], params: [], successCount: 1 },
  { id: 'b', class: 'PURE_LOGIC', matchers: [ { type: 'keywords', all: ['foo'] } ], params: [], successCount: 5 }
];
assert.strictEqual(router.classify('foo please', tie).entry.id, 'b', 'higher successCount breaks the tie');

// --- Cycle C: registry register / validate / accessors (no I/O) ---
const goodBuiltins = [
  { id: 'math.eval', class: 'PURE_LOGIC', handler: 'builtin:math', matchers: [], params: [] },
  { id: 'app.open', class: 'HYBRID_UIA', handler: 'delegate:automation',
    matchers: [ { type: 'keywords', all: ['open'] } ], params: [] }
];
let reg = registry.createRegistry({ builtins: goodBuiltins }); // no filePath -> in-memory only
assert.strictEqual(reg.all().length, 2);
assert.strictEqual(reg.byId('math.eval').source, 'builtin');
assert.strictEqual(reg.byId('math.eval').gui_forbidden, true, 'PURE_LOGIC is gui_forbidden');
assert.strictEqual(reg.byId('app.open').gui_forbidden, false, 'HYBRID_UIA is not gui_forbidden');
assert.strictEqual(reg.byClass('PURE_LOGIC').length, 1);
assert.strictEqual(reg.byId('missing'), null);

// validateEntry catches malformed entries and accepts well-formed ones
assert.ok(registry.validateEntry({}).length > 0);
assert.ok(registry.validateEntry({ id: 'x', class: 'BOGUS', handler: 'h' }).length > 0);
assert.ok(registry.validateEntry({ id: 'x', class: 'HYBRID_UIA', handler: 'h', matchers: [{ type: 'nope' }] }).length > 0);
assert.strictEqual(registry.validateEntry({ id: 'x', class: 'PURE_LOGIC', handler: 'h', matchers: [], params: [] }).length, 0);

// a malformed builtin is a developer error -> throws loudly
assert.throws(() => registry.createRegistry({ builtins: [ { id: 'bad' } ] }));

// --- Cycle D: persistence, quarantine, touch (DI temp file) ---
function tmpFile(name) {
  const dir = path.join(os.tmpdir(), 'caryl-kernel-test');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name + '-' + Date.now() + '.json');
}

// record() persists ONLY learned entries; builtins stay in code
const file = tmpFile('reg');
reg = registry.createRegistry({ filePath: file, builtins: goodBuiltins });
reg.record({ id: 'wa.send', class: 'HYBRID_UIA', handler: 'macro:wa',
  matchers: [ { type: 'keywords', all: ['whatsapp'] } ], params: [] });
const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.ok(Array.isArray(onDisk) && onDisk.length === 1, 'only the learned entry is written');
assert.strictEqual(onDisk[0].id, 'wa.send');
assert.ok(onDisk.every((e) => e.source === 'learned'), 'builtins are never written to disk');

// a fresh registry loads learned entries from disk AND registers builtins
const reg2 = registry.createRegistry({ filePath: file, builtins: goodBuiltins });
assert.ok(reg2.byId('wa.send'), 'learned entry loaded from disk');
assert.ok(reg2.byId('math.eval'), 'builtin still present');
assert.strictEqual(reg2.all().length, 3);

// gui_forbidden is re-derived on load even if the file was tampered
fs.writeFileSync(file, JSON.stringify([
  { id: 'wa.send', class: 'HYBRID_UIA', handler: 'macro:wa', matchers: [], params: [], gui_forbidden: true, source: 'learned' }
]));
const reg3 = registry.createRegistry({ filePath: file, builtins: goodBuiltins });
assert.strictEqual(reg3.byId('wa.send').gui_forbidden, false, 'class HYBRID_UIA overrides a tampered gui_forbidden');

// a bad learned entry is quarantined (skipped + recorded), the good one survives, no throw
fs.writeFileSync(file, JSON.stringify([
  { id: 'good', class: 'PURE_LOGIC', handler: 'h', matchers: [], params: [] },
  { id: 'bad', class: 'NOPE' }
]));
const reg4 = registry.createRegistry({ filePath: file, builtins: goodBuiltins });
assert.ok(reg4.byId('good'), 'valid learned entry kept');
assert.strictEqual(reg4.byId('bad'), null, 'invalid learned entry skipped');
assert.strictEqual(reg4.quarantined.length, 1, 'invalid entry recorded for observability');

// a corrupt file degrades to builtins-only, never throws
fs.writeFileSync(file, 'not json {{{');
const reg5 = registry.createRegistry({ filePath: file, builtins: goodBuiltins });
assert.strictEqual(reg5.all().length, 2, 'corrupt file -> builtins only');

// touch() bumps counters and stamps lastUsed; a failed use does not bump successCount
reg.touch('wa.send', { success: true });
assert.strictEqual(reg.byId('wa.send').useCount, 1);
assert.strictEqual(reg.byId('wa.send').successCount, 1);
assert.strictEqual(typeof reg.byId('wa.send').lastUsed, 'string');
reg.touch('wa.send', { success: false });
assert.strictEqual(reg.byId('wa.send').useCount, 2);
assert.strictEqual(reg.byId('wa.send').successCount, 1, 'failed use does not bump successCount');

// --- Cycle E: math matcher precision against the real BUILTINS ---
// The math task must fire on genuine calculations but NOT on number ranges / ratios that
// happen to look like arithmetic ("9-5 job", "3-5 business days", "24/7 support").
function isMath(text) {
  const m = router.classify(text, BUILTINS);
  return !!(m && m.entry.id === 'math.eval');
}

// true negatives: ordinary phrases with number-dash / number-slash are NOT arithmetic
assert.strictEqual(isMath('9-5 job'), false, 'a work schedule is not a calculation');
assert.strictEqual(isMath('3-5 business days'), false, 'a range is not a calculation');
assert.strictEqual(isMath('24/7 support'), false, 'a ratio phrase is not a calculation');
assert.strictEqual(isMath('i have 2 cats and 3 dogs'), false, 'numbers in prose are not a calculation');

// true positives: real calculations still classify
assert.ok(isMath('2 + 3'), 'a bare expression is a calculation');
assert.ok(isMath('12.5% of 340'), 'percent-of is a calculation');
assert.ok(isMath('2 * 4'), 'a bare expression is a calculation');
assert.ok(isMath('what is 2 + 3'), 'cue + expression is a calculation');
assert.ok(isMath('calculate 15% of 200'), 'cue + percent-of is a calculation');
assert.ok(isMath('how much is 24/7'), 'an explicit cue makes even 24/7 a calculation');

// the expression is still extracted correctly after tightening
const mMath = router.classify('what is 12.5% of 340', BUILTINS);
assert.strictEqual(mMath.params.expression, '12.5% of 340');

console.log('test-kernel: all assertions passed');
