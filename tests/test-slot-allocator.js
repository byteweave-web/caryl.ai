// tests/test-slot-allocator.js
// Pure tests for the Unified OS slot allocator (spec §9). node + assert.
const assert = require('assert');
const A = require('../renderer/slot-allocator');

// solo element takes its preferred slot, solid
let r = A.allocate([{ id: 'cam', priority: 50, slots: ['BR', 'TR'] }], []);
assert.deepStrictEqual(r.placements.cam, { slot: 'BR', ghost: false }, 'solo -> preferred');

// higher priority evicts: lower re-anchors to its next acceptable slot
r = A.allocate([
  { id: 'cam', priority: 50, slots: ['BR', 'TR', 'TL'] },
  { id: 'toast', priority: 90, slots: ['BR'] },
], []);
assert.deepStrictEqual(r.placements.toast, { slot: 'BR', ghost: false }, 'high prio wins BR');
assert.deepStrictEqual(r.placements.cam, { slot: 'TR', ghost: false }, 'low prio re-anchors');

// external occupancy blocks a slot outright
r = A.allocate([{ id: 'cam', priority: 50, slots: ['BR', 'TR'] }], ['BR']);
assert.deepStrictEqual(r.placements.cam, { slot: 'TR', ghost: false }, 'external -> re-anchor');

// nothing free -> ghost IN PLACE at the preferred slot, after the solid occupant
r = A.allocate([
  { id: 'toast', priority: 90, slots: ['TR'] },
  { id: 'cam', priority: 50, slots: ['TR'] },
], []);
assert.deepStrictEqual(r.placements.cam, { slot: 'TR', ghost: true }, 'no slot free -> ghost in place');
assert.deepStrictEqual(r.ghosted, ['cam'], 'ghost list');
assert.deepStrictEqual(r.zones.TR, ['toast', 'cam'], 'zone hosts solid first, then ghost');

// everything acceptable externally covered -> ghost at home
r = A.allocate([{ id: 'dock', priority: 20, slots: ['BL'] }], ['BL']);
assert.deepStrictEqual(r.placements.dock, { slot: 'BL', ghost: true }, 'external-only -> ghost at home');

// priority ties keep input (registration) order
r = A.allocate([
  { id: 'a', priority: 50, slots: ['TL', 'TR'] },
  { id: 'b', priority: 50, slots: ['TL', 'TR'] },
], []);
assert.strictEqual(r.placements.a.slot, 'TL', 'tie: first registered wins TL');
assert.strictEqual(r.placements.b.slot, 'TR', 'tie: second takes next');

// unknown slot names are filtered; an empty acceptable list -> {slot:null, ghost:true}
r = A.allocate([{ id: 'x', priority: 10, slots: ['NOPE', 'TL'] }], []);
assert.deepStrictEqual(r.placements.x, { slot: 'TL', ghost: false }, 'unknown names filtered');
r = A.allocate([{ id: 'x', priority: 10, slots: ['NOPE'] }], []);
assert.deepStrictEqual(r.placements.x, { slot: null, ghost: true }, 'no valid slots -> null+ghost');

// CENTER is a modelled slot (external CENTER occupancy is representable)
r = A.allocate([{ id: 'x', priority: 10, slots: ['CENTER'] }], ['CENTER']);
assert.deepStrictEqual(r.placements.x, { slot: 'CENTER', ghost: true }, 'CENTER blockable');

// releasing = allocating without the element (pure function: absence is release)
r = A.allocate([{ id: 'cam', priority: 50, slots: ['BR'] }], []);
assert.strictEqual(r.placements.cam.slot, 'BR', 'cam returns to BR once toast is gone');

// junk inputs never throw
assert.doesNotThrow(function () { A.allocate(null, null); A.allocate([{}], undefined); });

console.log('test-slot-allocator: OK');
