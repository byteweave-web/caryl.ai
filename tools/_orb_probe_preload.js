// Test-only preload for tools/shot_orb_tab.js — NOT shipped.
// index.html's real preload (preload.js) exposes window.bridge/api over IPC.
// Offscreen we have no backend, so stub every bridge/api call generically with a
// Proxy whose members are callable and return resolved promises. This lets the
// real renderer script run past its top-level IPC calls (getShellStyle, etc.)
// through to initOrb(), so the parent→deck postMessage bridge actually executes.
function autoApi() {
  return new Proxy(function () {}, {
    get: (_t, prop) => (prop === 'then' ? undefined : autoApi()),
    apply: () => Promise.resolve({}),
  });
}
for (const k of ['bridge', 'api', 'electron', 'electronAPI']) {
  try { window[k] = autoApi(); } catch (_) {}
}
