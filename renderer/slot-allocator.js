// renderer/slot-allocator.js
// Pure, DOM-free corner-slot allocation for the Unified OS (spec §9): named slots,
// priorities, acceptable-slot lists, re-anchor on collision, ghost when nothing is free.
// Dual-exported: window.SlotAllocator (renderer <script>) AND module.exports (node tests).
// Same input -> same output, no side effects. system-shell.js applies the output to the DOM.
(function (root) {
  'use strict';

  var SLOTS = ['TL', 'TR', 'BL', 'BR', 'CENTER'];

  function validSlots(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (s) {
      if (SLOTS.indexOf(s) >= 0 && out.indexOf(s) < 0) out.push(s);
    });
    return out;
  }

  // elements: [{id, priority, slots:[preference order]}]; external: slot names covered by
  // real satellite windows — absolutely unavailable. Higher priority wins; ties keep input
  // order. An element with no free acceptable slot ghosts IN PLACE at its preferred slot
  // (slots[0]) — visible at 35%, never vanished. No valid slots at all -> {slot:null, ghost}.
  function allocate(elements, external) {
    var ext = validSlots(external);
    var els = (Array.isArray(elements) ? elements : [])
      .filter(function (e) { return e && typeof e.id === 'string' && e.id; })
      .map(function (e, i) { return { id: e.id, priority: +e.priority || 0, slots: validSlots(e.slots), order: i }; });
    els.sort(function (a, b) { return (b.priority - a.priority) || (a.order - b.order); });

    var taken = {};
    var placements = {};
    var zones = { TL: [], TR: [], BL: [], BR: [], CENTER: [] };
    var ghosted = [];

    els.forEach(function (e) {
      var slot = null;
      for (var i = 0; i < e.slots.length; i++) {
        var s = e.slots[i];
        if (ext.indexOf(s) < 0 && !taken[s]) { slot = s; break; }
      }
      if (slot) {
        taken[slot] = e.id;
        placements[e.id] = { slot: slot, ghost: false };
        zones[slot].push(e.id);
      } else {
        var home = e.slots.length ? e.slots[0] : null;
        placements[e.id] = { slot: home, ghost: true };
        if (home) zones[home].push(e.id);
        ghosted.push(e.id);
      }
    });

    return { placements: placements, zones: zones, ghosted: ghosted };
  }

  var api = { allocate: allocate, SLOTS: SLOTS };
  root.SlotAllocator = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
