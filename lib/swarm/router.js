// lib/swarm/router.js
// ------------------------------------------------------------------
// Swarm dispatch router. The 120B (the "Orchestrator" agent) emits
// newline-delimited JSON dispatch payloads per prompts/orchestrator-system.md §2.2:
//
//   {"to":"Executor","task_id":"t-001","action":"send_whatsapp_message","data":{...}}
//   {"to":"Critic",  "task_id":"crit-001","action":"critic.propose_fix","data":{...}}
//
// This module:
//   - validates each payload against the 7-agent alphabet,
//   - emits `dispatch-start` to listeners BEFORE awaiting the handler
//     so the renderer can animate the orb-layer immediately while the
//     handler is still running (UIA workflows take seconds),
//   - emits `dispatch-end` (or `dispatch-rejected` for validation failures),
//   - retries failures through Critic up to N times (default 3), stripping
//     any existing `.K` retry suffix before appending the next attempt so
//     a retry of `t-001.1` becomes `t-001.2`, not `t-001.1.1`.
//   - parses raw model replies as JSONL (newline-delimited JSON objects),
//     NOT as a single JSON array — the prompt format is one object per line.
// ------------------------------------------------------------------

'use strict';

const EVENT_CHANNEL = 'swarm:event';

const ALLOWED_AGENTS = Object.freeze([
  'Orchestrator', 'Researcher', 'Executor', 'Coder', 'Memory', 'Vision', 'Critic',
]);

// Strip any trailing `.<digits>` retry suffix from a task_id so we never stack
// suffixes on a retry (e.g. `t-001.1` → `t-001`, then next retry → `t-001.2`).
function stripRetrySuffix(taskId) {
  if (typeof taskId !== 'string') return taskId;
  return taskId.replace(/\.\d+$/, '');
}

// Recognise handler error messages that mean "the AI provider is throttling us".
// We treat these as terminal in `dispatchWithCritic`: re-asking Critic for a fix
// would burn another Gemini call and almost certainly 429 again, which is
// exactly the burst pattern Google's anti-abuse detector watches for. The
// global Cooldown gate in lib/providers.js will already have been tripped by
// the original failing call, so the next user action will surface a friendly
// "cool-down for Xs" message instead of a silent retry storm.
const _RATE_LIMIT_PATTERNS = [
  /\b429\b/,                              // plain HTTP 429
  /rate.?limit/i,                         // "rate limit", "rate-limit", "Rate limited"
  /cool.?down/i,                          // "cooldown", "cool-down"
  /unusual traffic/i,                     // Google anti-abuse page
  /automated requests/i,                  // Google anti-abuse page
  /please try your request again later/i, // Google anti-abuse page
  /\bCOOLDOWN\b/,                         // providers.js tagged error code
];
function isRateLimitError(errMsg) {
  if (!errMsg) return false;
  const s = String(errMsg);
  return _RATE_LIMIT_PATTERNS.some(function (rx) { return rx.test(s); });
}

class SwarmRouter {
  /**
   * @param {{ registry: Record<string,(d:any)=>Promise<any>>, emitter?: (ev:any)=>void }} opts
   *   - registry: map of agent-name → async handler(dispatch) → { ok, ... }
   *   - emitter: function called for every swarm:event. Renderer listeners
   *              are wired separately through ipcRenderer.on('swarm:event', ...)
   *              in preload.js; main.js funnels router.emitter → wc.send().
   */
  constructor(opts = {}) {
    this.registry = (opts && opts.registry) || {};
    this.emitter = (opts && opts.emitter) || (() => {});
  }

  validate(dispatch) {
    if (!dispatch || typeof dispatch !== 'object' || Array.isArray(dispatch)) {
      return { error: 'dispatch_not_object' };
    }
    if (!ALLOWED_AGENTS.includes(dispatch.to)) {
      return { error: 'unknown_to', to: dispatch.to, allowed: ALLOWED_AGENTS };
    }
    if (typeof dispatch.action !== 'string' || !dispatch.action) {
      return { error: 'missing_action' };
    }
    if (dispatch.task_id != null && typeof dispatch.task_id !== 'string') {
      return { error: 'bad_task_id' };
    }
    if (dispatch.data != null && typeof dispatch.data !== 'object') {
      return { error: 'bad_data' };
    }
    if (dispatch.to === 'Orchestrator') {
      return { error: 'self_dispatch_forbidden' };
    }
    return null;
  }

  /**
   * Dispatch one payload. Streams events to listeners so the orb layer
   * in the renderer can animate in lock-step with the handler.
   */
  async dispatch(d) {
    const err = this.validate(d);
    if (err) {
      this.emitter({ kind: 'dispatch-rejected', error: err });
      return { ok: false, error: JSON.stringify(err) };
    }

    // Emit BEFORE awaiting — the handler may take seconds (UIA workflows).
    this.emitter({
      kind: 'dispatch-start',
      to: d.to,
      task_id: d.task_id,
      action: d.action,
    });

    let res;
    try {
      const fn = this.registry[d.to];
      if (typeof fn !== 'function') {
        res = { ok: false, error: 'no_handler_for_' + d.to };
      } else {
        res = await fn(d);
      }
    } catch (e) {
      res = {
        ok: false,
        error: 'handler_threw: ' + (e && e.message ? e.message : String(e)),
      };
    }
    res = res || { ok: false, error: 'handler_returned_undefined' };

    this.emitter({
      kind: 'dispatch-end',
      to: d.to,
      task_id: d.task_id,
      action: d.action,
      ok: res.ok === true,
      error: res.error,
      // Carry the patch payload for Coder so the renderer's DiffModal can
      // open WITHOUT a second round-trip. We deliberately do NOT carry
      // large payloads for other agents — UIA excerpts can be many KB.
      ...(d.to === 'Coder' && res.ok === true
        ? { proposed_patch: res.proposed_patch || '', diff_text: res.diff_text || '', template_used: res.template_used || 'unknown', notes: res.notes || '' }
        : {}),
    });
    return res;
  }

  /**
   * Dispatch with the full Critic retry loop per prompts/orchestrator-system.md §4.
   * @param {object} initial — original dispatch payload (must include `to`, `action`, `data`).
   * @param {{ maxRetries?: number }} opts — cap is 2 by default. (Was 3; reduced to
   *        cut the worst-case burst from 4 calls (1 + 3 retries) to 3, which keeps
   *        us comfortably under Gemini's per-IP pulse threshold and avoids the
   *        "unusual traffic" anti-abuse page-trip on sustained failures.)
   */
  async dispatchWithCritic(initial, opts = {}) {
    const maxRetries = Number.isFinite(opts.maxRetries) ? Math.min(opts.maxRetries, 5) : 2;
    let attempt = 0;
    let current = Object.assign({}, initial, {
      task_id: initial.task_id || `t-${Date.now()}`,
    });
    let lastError = null;
    while (attempt <= maxRetries) {
      const res = await this.dispatch(current);
      if (res && res.ok) {
        return { ok: true, attempts: attempt + 1, result: res, task_id: current.task_id };
      }
      lastError = (res && res.error) || 'unknown_failure';
      attempt += 1;
      if (attempt > maxRetries) break;

      // Anti-abuse short-circuit: if the failure was a rate-limit / cooldown /
      // unusual-traffic error, do NOT call Critic. The global cooldown gate
      // (lib/providers.js + lib/ratelimit.js) is already in effect, and asking
      // Critic for a fix would burn another Gemini call that will also 429.
      // Surface the cool-down immediately so the user sees a clear error.
      if (isRateLimitError(lastError)) {
        this.emitter({
          kind: 'dispatch-rate-limited',
          to: current.to,
          task_id: current.task_id,
          action: current.action,
          error: lastError,
        });
        return {
          ok: false,
          attempts: attempt,
          error: lastError,
          critic: 'skipped_rate_limit',
        };
      }

      // Ask Critic for a fix. Critic may either return mutated_dispatch (retry) or
      // mark action === 'critic.give_up' (no fix possible).
      const fix = await this.dispatch({
        to: 'Critic',
        task_id: `crit-${Date.now()}-${attempt}`,
        action: 'critic.propose_fix',
        data: { original: current, error: lastError, attempt },
      });
      if (!fix || fix.ok !== true) {
        return { ok: false, attempts: attempt, error: lastError, critic: 'give_up' };
      }
      if (fix.action === 'critic.give_up' || !fix.mutated_dispatch) {
        return {
          ok: false,
          attempts: attempt,
          error: lastError,
          critic: 'give_up',
          reason: fix.final_reason || (fix.data && fix.data.final_reason) || null,
        };
      }
      const baseId = stripRetrySuffix(current.task_id) || 't-1';
      current = Object.assign({}, fix.mutated_dispatch, { task_id: `${baseId}.${attempt}` });
    }
    return { ok: false, attempts: maxRetries, error: lastError, critic: 'give_up' };
  }

  /**
   * Parse raw model reply text into an array of dispatch payloads.
   * Each non-empty line that parses as a JSON object with a `to` string
   * is included. Lines that fail JSON.parse are silently skipped (the
   * prompt's strict format means this should be rare).
   */
  static parseDispatchPayloads(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return [];
    const out = [];
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      try {
        const obj = JSON.parse(t);
        if (obj && typeof obj === 'object' && typeof obj.to === 'string') {
          out.push(obj);
        }
      } catch (_e) {
        // skip non-JSON lines (markdown tables, prose, etc.)
      }
    }
    return out;
  }

  /**
   * Run a parsed chain of dispatches in dependency order. Each dispatch may
   * carry `data.depends_on: ['task_id', ...]` referencing earlier outputs.
   * Returns the aggregated results keyed by task_id.
   */
  async dispatchChain(payloads) {
    if (!Array.isArray(payloads) || payloads.length === 0) {
      return { ok: true, results: {}, count: 0 };
    }
    const results = {};
    const order = topologicalOrder(payloads);
    for (const d of order) {
      const res = await this.dispatchWithCritic(d);
      results[d.task_id || `idx-${order.indexOf(d)}`] = res;
    }
    return { ok: true, results, count: payloads.length };
  }
}

// Return payload list in dependency-topological order. Independent payloads
// keep their input order; dependents come after their prerequisites. Cycles
// are detected and broken gracefully (cycle nodes appended last).
function topologicalOrder(payloads) {
  const byId = new Map();
  payloads.forEach((p, i) => {
    const id = p.task_id || `__auto_${i}`;
    byId.set(id, Object.assign({}, p, { task_id: id }));
  });
  const visited = new Set();
  const onStack = new Set();
  const out = [];
  const visit = (id) => {
    if (visited.has(id)) return;
    if (onStack.has(id)) return; // cycle — skip
    const node = byId.get(id);
    if (!node) return;
    onStack.add(id);
    const deps = Array.isArray(node.data && node.data.depends_on) ? node.data.depends_on : [];
    for (const dep of deps) {
      if (byId.has(dep)) visit(dep);
    }
    onStack.delete(id);
    visited.add(id);
    out.push(node);
  };
  for (const p of payloads) {
    const id = p.task_id || `__auto_${payloads.indexOf(p)}`;
    visit(id);
  }
  return out;
}

module.exports = {
  SwarmRouter,
  stripRetrySuffix,
  topologicalOrder,
  isRateLimitError,
  ALLOWED_AGENTS,
  EVENT_CHANNEL,
};
