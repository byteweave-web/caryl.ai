// lib/cameraUi.js
// ------------------------------------------------------------------
// Pure helpers for the camera shell (D1). No Electron/DOM: unit-tested
// under plain node (tests/test-camera-ui.js runs in `npm test`) and
// exposed to the sandboxed renderer through preload.js:
//
//   window.bridge.cameraGreeting(name)  -> spoken greeting text
//   window.bridge.cameraStatus(state)   -> pill label
//
// These are the SINGLE SOURCE of truth for those two strings inside
// the project, so a name change or a new state is one PR, not three.
// ------------------------------------------------------------------

'use strict';

// Default placeholder assistant name; a real one produces a personalised
// greeting. Exported so preload can sanity-check the default if needed.
const DEFAULT_NAME = 'Caryl';

// Internal camera state -> the status-pill label shown in the top bar.
// Unknown states (incl. null/undefined/empty) safely fall back to Idle.
const STATUS = Object.freeze({
  idle:      'Idle',
  listening: 'Listening\u2026',
  looking:   'Looking\u2026',
  speaking:  'Speaking\u2026',
  error:     'Camera error',
});

// Spoken greeting when camera mode opens. A real string name personalises
// it; blank/whitespace/non-string inputs -> the safe generic line. We
// deliberately reject non-strings (objects, numbers, arrays) instead of
// String()-coercing them: that path produced ugly lines like
// "[object Object] here \u2014 ..." that no user wants to hear.
function greetingLine(name) {
  const n = (typeof name === 'string') ? name.trim() : '';
  if (!n) return 'Hey \u2014 what are we looking at?';
  return n + ' here \u2014 what are we looking at?';
}

// Map an internal state to the status-pill label. Unknown -> Idle so
// callers can pass raw user input / legacy states without a crash.
function statusLabel(state) {
  return STATUS[String(state || '')] || 'Idle';
}

module.exports = {
  greetingLine,
  statusLabel,
  DEFAULT_NAME,
  // Exported for tests that want to assert the full label set without
  // listing it twice in two places. Not part of the runtime API.
  _STATUS: STATUS,
};
