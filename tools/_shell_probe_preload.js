// Test-only preload for tools/probe_shell.js — NOT shipped.
// index.html's real preload exposes window.bridge/api over IPC; offscreen there is no
// backend, so stub every bridge/api member with a Proxy that is callable and returns a
// resolved promise. Lets the real renderer script run past its top-level IPC calls.
function autoApi() {
  return new Proxy(function () {}, {
    get: (_t, p) => (p === 'then' ? undefined : autoApi()),
    apply: () => Promise.resolve({}),
  });
}
for (const k of ['bridge', 'api', 'electron', 'electronAPI']) {
  try { window[k] = autoApi(); } catch (_) {}
}
