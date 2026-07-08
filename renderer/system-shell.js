// renderer/system-shell.js
// The runtime that applies the pure reducer's targets to the DOM. CSS @property eases
// --focus-depth / --glass-density, so this file only sets targets, toggles the active
// focus layer + its tab, dims the marginalia, and throttles the engine when it's occluded.
(function () {
  'use strict';
  if (!window.ShellReducer) { console.error('[shell] ShellReducer missing'); return; }
  var R = window.ShellReducer;
  var root = document.documentElement;

  var state = { focus: 'orb', coverage: 0, power: 'normal', reducedMotion: false, win10: false };

  function readEnv() {
    state.win10 = root.dataset.os === 'win10';
    try { state.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_e) {}
  }

  function apply() {
    var t = R.deriveShell(state);
    // Ease targets (CSS @property does the interpolation).
    root.style.setProperty('--focus-depth', String(t.focusDepthTarget));
    root.style.setProperty('--glass-density', String(t.glassDensityTarget));
    root.style.setProperty('--marginalia-dim', String(t.marginaliaDim));
    // Toggle the single active focus layer (orb = none) and keep the tab chrome in sync.
    document.querySelectorAll('.view').forEach(function (v) {
      v.classList.toggle('active', v.id === 'view-' + t.focus);
    });
    document.querySelectorAll('.tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === t.focus);
    });
    root.setAttribute('data-focus', t.focus);
    // Broadcast focus changes so decoupled surfaces (e.g. the Chat peripheral dock) can react
    // without the runtime knowing about them.
    try { document.dispatchEvent(new CustomEvent('shell:focus', { detail: { focus: t.focus } })); } catch (_e) {}
    // Engine throttle: reuse the deck's existing pause contract. The engine renders whenever
    // it is visible (not occluded, i.e. not throttled) — including behind translucent Chat.
    try { if (typeof window.deckSetActive === 'function') window.deckSetActive(!t.engineThrottle); } catch (_e) {}
  }

  // ---- Phase 5: the slot layer (spec §9) ----
  // Pure allocation lives in slot-allocator.js; this applies placements to the DOM:
  // reparent each claimed element into its corner zone, stamp data-slot, toggle ghosting.
  var claims = {};        // id -> { priority, slots, el }
  var externalSlots = []; // slot names covered by satellite windows (absolute)

  function zoneEl(slot) { return document.getElementById('slot-' + slot); }

  function claimList() {
    return Object.keys(claims).map(function (id) {
      return { id: id, priority: claims[id].priority, slots: claims[id].slots };
    });
  }

  function applySlots() {
    if (!window.SlotAllocator) return;
    var out = window.SlotAllocator.allocate(claimList(), externalSlots);
    Object.keys(out.placements).forEach(function (id) {
      var c = claims[id]; if (!c || !c.el) return;
      var p = out.placements[id];
      var zone = p.slot && zoneEl(p.slot);
      if (zone && c.el.parentElement !== zone) zone.appendChild(c.el);
      if (p.slot) c.el.dataset.slot = p.slot; else delete c.el.dataset.slot;
      c.el.classList.toggle('ghosted', !!p.ghost);
    });
    // A zone "has a ghost" when any current child is ghosted (it becomes the hover surface).
    ['TL', 'TR', 'BL', 'BR'].forEach(function (s) {
      var z = zoneEl(s); if (!z) return;
      z.classList.toggle('has-ghost', !!z.querySelector('.ghosted'));
    });
    try { document.dispatchEvent(new CustomEvent('shell:slots', { detail: Slots.get() })); } catch (_e) {}
  }

  var Slots = {
    // A claim is an upsert; the claim owns the element's placement from here on.
    claim: function (id, spec) {
      if (!id || !spec || !spec.el) return;
      claims[id] = { priority: +spec.priority || 0, slots: (spec.slots || []).slice(), el: spec.el };
      applySlots();
    },
    // Release also removes the element from its zone (it was ours to place).
    release: function (id) {
      var c = claims[id];
      if (!c) return;
      delete claims[id];
      if (c.el) {
        c.el.classList.remove('ghosted');
        delete c.el.dataset.slot;
        if (c.el.parentElement && c.el.parentElement.classList.contains('slotzone')) c.el.remove();
      }
      applySlots();
    },
    external: function (list) {
      externalSlots = Array.isArray(list) ? list.slice() : [];
      applySlots();
    },
    get: function () {
      var out = window.SlotAllocator
        ? window.SlotAllocator.allocate(claimList(), externalSlots)
        : { placements: {}, zones: {}, ghosted: [] };
      return { placements: out.placements, ghosted: out.ghosted, external: externalSlots.slice() };
    },
  };

  // ---- Phase 5: the shell toast — the single L3 transient chip (spec §9) ----
  // One reusable element; a toast claims a corner at high priority and auto-releases.
  var toastEl = null, toastTimer = null;
  function toast(text, opts) {
    opts = opts || {};
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'shell-toast glass';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
    }
    toastEl.textContent = String(text || '');
    Slots.claim('toast', { priority: 90, slots: ['TR', 'TL', 'BR'], el: toastEl });
    requestAnimationFrame(function () { if (toastEl) toastEl.classList.add('show'); });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastTimer = null;
      if (toastEl) toastEl.classList.remove('show');
      Slots.release('toast');
    }, Math.max(600, +opts.ms || 3200));
  }

  // ---- Phase 6: the action chip — a toast with buttons (scene-watcher suggestions) ----
  // One at a time (spec D3: ONE high-confidence suggestion); a new chip replaces the old.
  var chipEl = null, chipTimer = null;
  function dismissChip() {
    if (chipTimer) { clearTimeout(chipTimer); chipTimer = null; }
    if (chipEl) chipEl.classList.remove('show');
    Slots.release('chip');
  }
  function chip(text, opts) {
    opts = opts || {};
    if (!chipEl) {
      chipEl = document.createElement('div');
      chipEl.className = 'shell-toast shell-chip glass';
      chipEl.setAttribute('role', 'status');
      chipEl.setAttribute('aria-live', 'polite');
    }
    chipEl.textContent = '';
    var msg = document.createElement('div');
    msg.className = 'chip-text';
    msg.textContent = String(text || '');
    chipEl.appendChild(msg);
    var row = document.createElement('div');
    row.className = 'chip-actions';
    (opts.actions || []).forEach(function (a, i) {
      if (!a || !a.label) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip-btn' + (i === 0 ? ' primary' : '');
      b.textContent = a.label;
      b.addEventListener('click', function () {
        try { if (typeof a.fn === 'function') a.fn(); } catch (_e) {}
        dismissChip();
      });
      row.appendChild(b);
    });
    chipEl.appendChild(row);
    Slots.claim('chip', { priority: 85, slots: ['TR', 'TL', 'BR'], el: chipEl });
    requestAnimationFrame(function () { if (chipEl) chipEl.classList.add('show'); });
    if (chipTimer) clearTimeout(chipTimer);
    chipTimer = setTimeout(dismissChip, Math.max(1500, +opts.ms || 12000));
  }

  var Shell = {
    state: state,
    slots: Slots,
    toast: toast,
    chip: chip,
    setFocus: function (name) {
      state.focus = (R.FOCUS.indexOf(name) >= 0) ? name : 'orb';
      apply();
    },
  };

  readEnv();
  apply();
  try { matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', function () { readEnv(); apply(); }); } catch (_e) {}
  window.Shell = Shell;
  // Phase 5: satellite windows (weather board, overlay card) report which shell corners
  // they physically cover; in-shell elements yield via the allocator. Guarded — the
  // offscreen probe harness stubs the bridge with a callable proxy that never calls back.
  try {
    if (window.bridge && typeof window.bridge.onSatellites === 'function') {
      window.bridge.onSatellites(function (p) {
        state.satellites = (p && p.sats) || [];
        Slots.external((p && p.slots) || []);
      });
    }
  } catch (_e) {}
})();
