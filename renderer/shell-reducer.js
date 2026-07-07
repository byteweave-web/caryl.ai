// renderer/shell-reducer.js
// Pure, DOM-free derivation of the System Shell's animated targets from its state.
// Dual-exported: window.ShellReducer (renderer <script>) AND module.exports (node tests).
// Same input -> same output, no side effects. This is the "brain"; system-shell.js applies it.
(function (root) {
  'use strict';

  // 'orb' means "no focus layer up" — the Core itself is in focus.
  var FOCUS = ['orb', 'chat', 'settings', 'camera', 'camera-full'];

  // z-index bands (spec §4.1).
  var Z = { engine: 0, marginalia: 10, focus: 20, transient: 30, veil: 40 };

  // Per-surface Dynamic Translucency ceiling (spec §3.5).
  var DENSITY = { orb: 0, chat: 0.62, settings: 0.72, camera: 0.55, 'camera-full': 0.98 };

  var OCCLUSION = 0.92; // >= this, the engine is considered hidden and may be throttled.

  function clamp01(n) { n = +n; if (!(n > 0)) return 0; return n > 1 ? 1 : n; }

  function deriveShell(state) {
    state = state || {};
    var focus = FOCUS.indexOf(state.focus) >= 0 ? state.focus : 'orb';
    var atOrb = focus === 'orb';

    var focusDepthTarget = atOrb ? 0 : 1;

    // Density target: the surface ceiling, forced to occlusion when fully covering the
    // window or when on battery-saver (a parked layer lets the engine throttle).
    var ceiling = DENSITY[focus] || 0;
    var coverage = clamp01(state.coverage);
    var density = atOrb ? 0 : ceiling;
    if (!atOrb && coverage >= 1) density = 1;
    if (!atOrb && state.power === 'saver') density = Math.max(density, OCCLUSION);
    density = clamp01(density);

    return {
      focus: focus,
      focusDepthTarget: focusDepthTarget,
      glassDensityTarget: density,
      engineThrottle: density >= OCCLUSION,
      marginaliaDim: atOrb ? 1 : 0.5,
      zTop: atOrb ? Z.marginalia : Z.focus,
      reducedMotion: !!state.reducedMotion
    };
  }

  var api = { deriveShell: deriveShell, FOCUS: FOCUS, Z: Z, DENSITY: DENSITY, OCCLUSION: OCCLUSION };
  root.ShellReducer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
