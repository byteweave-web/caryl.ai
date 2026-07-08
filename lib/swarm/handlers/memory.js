// lib/swarm/handlers/memory.js
// ------------------------------------------------------------------
// Memory agent: long-term recall/persist/summarize against lib/memory.js.
// `mem` is injected at registry-build time so this module stays pure.
// All ops read or write through the existing RAG entry path; no new
// schema is introduced. Returns the same op-specific value the UI
// bridge already exposes, so the renderer can render either source
// identically.
// ------------------------------------------------------------------

'use strict';

const ALLOWED = ['recall', 'persist', 'summarize'];

async function invoke(d, mem) {
  const op = String(d.action || '').split('.').pop();
  if (!ALLOWED.includes(op)) {
    return { ok: false, error: 'unknown_memory_op', allowed: ALLOWED };
  }
  if (!mem || typeof mem !== 'object') {
    return { ok: false, error: 'memory_module_not_injected' };
  }
  try {
    if (op === 'recall') {
      const key = d.data && d.data.key;
      const out = typeof mem.recall === 'function'
        ? await mem.recall(key, d.data || {})
        : null;
      return { ok: true, agent: 'Memory', op, value: out };
    }
    if (op === 'persist') {
      const key = d.data && d.data.key;
      const value = d.data && d.data.value;
      if (typeof mem.persist === 'function') {
        await mem.persist(key, value);
      }
      return { ok: true, agent: 'Memory', op, stored: true };
    }
    if (op === 'summarize') {
      const out = typeof mem.summarize === 'function'
        ? await mem.summarize(d.data || {})
        : null;
      return { ok: true, agent: 'Memory', op, value: out };
    }
  } catch (e) {
    return {
      ok: false,
      agent: 'Memory',
      op,
      error: 'memory_threw: ' + (e && e.message ? e.message : String(e)),
    };
  }
  return { ok: false, error: 'unreachable' };
}

module.exports = { invoke };
