// lib/swarm/handlers/index.js
// ------------------------------------------------------------------
// Builds the per-agent handler map the SwarmRouter dispatches into.
// Each agent is an async (dispatch) => { ok, ... }; purity is on purpose —
// the router doesn't care what a handler does internally, it only cares
// about the {ok, error?} shape in the return value.
//
// Executor is special: it needs the existing main-process `sidecarCall(/uia_run)`
// to forward the dispatched intent into the Python sidecar. We inject a
// closure at registry-build time so this module stays free of main.js imports
// (works the same in main.js, in tests, and in any future embedded runner).
// ------------------------------------------------------------------

'use strict';

const path = require('path');

const { invoke: researcherInvoke } = require('./researcher');
const { invoke: executorInvokeImpl } = require('./executor');
const { invoke: coderInvoke } = require('./coder');
const { invoke: memoryInvoke } = require('./memory');
const { invoke: visionInvoke } = require('./vision');
const { invoke: criticInvoke } = require('./critic');

// `exec` is an injected closure around the existing sidecar (the binary part
// of the bridge from main.js -> automation.py /uia_run). If exec is not given
// we keep a pass-through stub so the swarm can still run in tests/headless.
function buildRegistry(deps = {}) {
  const exec = typeof deps.executorInvoke === 'function'
    ? (d) => deps.executorInvoke(d)
    : (d) => ({ ok: false, error: 'executor_not_wired' });

  return {
    // Orchestrator self-dispatch is rejected by the router's validate() step,
    // but keep a stub here so the registry is complete and never throws.
    Orchestrator: async () => ({ ok: false, error: 'self_dispatch_forbidden' }),

    Researcher: researcherInvoke,
    Executor:   async (d) => executorInvokeImpl(d, exec),
    Coder:      coderInvoke,
    Memory:     memoryInvoke,
    Vision:     visionInvoke,
    Critic:     criticInvoke,
  };
}

module.exports = {
  buildRegistry,
  // Re-exports kept for convenience — useful in tests.
  researcherInvoke: null, // re-exported via buildRegistry
  executorInvoke: null,
  coderInvoke: null,
  memoryInvoke: null,
  visionInvoke: null,
  criticInvoke: null,
};
