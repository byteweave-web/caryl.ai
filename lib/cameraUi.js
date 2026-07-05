// lib/cameraUi.js
// Pure helpers for the camera shell (D1). No Electron/DOM: unit-tested under plain node and
// exposed to the sandboxed renderer through preload.js (window.bridge.cameraGreeting/Status).

// The default/placeholder assistant name; a real one produces a personalised greeting.
const DEFAULT_NAME = 'Caryl';

// Spoken greeting when camera mode opens. A real name personalises it; blank -> generic.
function greetingLine(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return 'Hey — what are we looking at?';
  return n + ' here — what are we looking at?';
}

// Internal camera state -> the status-pill label shown in the top bar. Unknown -> Idle.
const STATUS = { idle: 'Idle', listening: 'Listening…', looking: 'Looking…', speaking: 'Speaking…', error: 'Camera error' };
function statusLabel(state) {
  return STATUS[String(state || '')] || 'Idle';
}

module.exports = { greetingLine, statusLabel, DEFAULT_NAME };
