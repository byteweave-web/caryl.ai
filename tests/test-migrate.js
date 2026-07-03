// tests/test-migrate.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateUserData } = require('../lib/migrate');

function tmp(name) {
  const p = path.join(os.tmpdir(), 'caryl-migrate-test', name + '-' + Date.now());
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// 1. no legacy dir -> nothing to do
let newDir = tmp('new1');
let r = migrateUserData(newDir, [path.join(os.tmpdir(), 'does-not-exist-xyz')]);
assert.strictEqual(r.migrated, false);
assert.strictEqual(r.reason, 'no-legacy');

// 2. legacy present, new empty -> copies everything + stamps migratedFrom
let legacy = tmp('legacy2');
fs.writeFileSync(path.join(legacy, 'settings.json'), JSON.stringify({ apiKey: 'k123', mode: 'offline' }));
fs.mkdirSync(path.join(legacy, 'openwakeword'), { recursive: true });
fs.writeFileSync(path.join(legacy, 'openwakeword', 'model.onnx'), 'bytes');
newDir = tmp('new2');
r = migrateUserData(newDir, [legacy]);
assert.strictEqual(r.migrated, true);
assert.strictEqual(r.from, legacy);
const moved = JSON.parse(fs.readFileSync(path.join(newDir, 'settings.json'), 'utf8'));
assert.strictEqual(moved.apiKey, 'k123');
assert.strictEqual(typeof moved.migratedFrom, 'string');
assert.strictEqual(fs.readFileSync(path.join(newDir, 'openwakeword', 'model.onnx'), 'utf8'), 'bytes');
// legacy untouched
assert.ok(fs.existsSync(path.join(legacy, 'settings.json')));
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(legacy, 'settings.json'), 'utf8')).migratedFrom, undefined);

// 3. new dir already has settings.json -> never overwrites (idempotent)
r = migrateUserData(newDir, [legacy]);
assert.strictEqual(r.migrated, false);
assert.strictEqual(r.reason, 'already-present');

// 4. two legacy candidates -> newest settings.json wins
const oldA = tmp('legacyA'); const oldB = tmp('legacyB');
fs.writeFileSync(path.join(oldA, 'settings.json'), JSON.stringify({ tag: 'A' }));
fs.writeFileSync(path.join(oldB, 'settings.json'), JSON.stringify({ tag: 'B' }));
const past = new Date(Date.now() - 86400000);
fs.utimesSync(path.join(oldA, 'settings.json'), past, past);
newDir = tmp('new4');
r = migrateUserData(newDir, [oldA, oldB]);
assert.strictEqual(r.migrated, true);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(newDir, 'settings.json'), 'utf8')).tag, 'B');

console.log('test-migrate: all assertions passed');
