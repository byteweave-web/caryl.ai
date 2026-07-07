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

  var Shell = {
    state: state,
    setFocus: function (name) {
      state.focus = (R.FOCUS.indexOf(name) >= 0) ? name : 'orb';
      apply();
    },
  };

  readEnv();
  apply();
  try { matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', function () { readEnv(); apply(); }); } catch (_e) {}
  window.Shell = Shell;
})();
