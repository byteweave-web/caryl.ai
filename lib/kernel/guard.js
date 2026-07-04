// lib/kernel/guard.js
// Per-turn GUI kill-switch, shared as a module singleton between the Kernel (which sets it
// when a task is classified PURE_LOGIC / API_NATIVE) and lib/actions.js (which reads it and
// refuses GUI tools while it's set). A singleton is safe here: the Electron main process
// handles one request turn at a time, and Node caches this module so every requirer sees
// the same state.
//
// isBlocked() returns the reason string while blocked, or null when the GUI is allowed.

let reason = null;

function block(why) { reason = String(why || 'blocked'); }
function unblock() { reason = null; }
function isBlocked() { return reason; }

module.exports = { block, unblock, isBlocked };
