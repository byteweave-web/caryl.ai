// lib/swarm/handlers/executor.js
// ------------------------------------------------------------------
// Executor: desktop automation via the existing /uia_run sidecar route.
// `exec` is the closure around main.js's `sidecarCall('/uia_run', ...)`.
// If exec is not provided, we return a tagged NOT_WIRED error so the
// Critic can easily propose_fix by suggesting the executor be injected.
// ------------------------------------------------------------------

'use strict';

async function invoke(d, exec) {
  if (typeof exec !== 'function') {
    return { ok: false, error: 'executor_not_wired' };
  }
  const intent = d.action; // bare intent_name per prompts/orchestrator-system.md §3
  if (!intent || typeof intent !== 'string') {
    return { ok: false, error: 'executor_missing_action' };
  }
  try {
    const r = await exec({ intent, params: d.data || {} });
    if (r && r.ok === true) {
      return {
        ok: true,
        agent: 'Executor',
        intent,
        result: r.result || r,
      };
    }
    return {
      ok: false,
      agent: 'Executor',
      intent,
      error: (r && (r.error || r.reason)) || 'uia_exec_failed',
    };
  } catch (e) {
    return {
      ok: false,
      agent: 'Executor',
      intent,
      error: 'sidecar_threw: ' + (e && e.message ? e.message : String(e)),
    };
  }
}

module.exports = { invoke };
