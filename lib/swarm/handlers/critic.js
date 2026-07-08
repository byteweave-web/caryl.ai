// lib/swarm/handlers/critic.js
// ------------------------------------------------------------------
// Critic: only agent that consumes failures. Per protocol §4 it has
// three response shapes:
//
//   1) { ok: true, action: 'critic.revised', mutated_dispatch: { ... } }
//        Run the new dispatch with task_id = oldId.K (router appends).
//   2) { ok: true, action: 'critic.fallback_vision' }
//        Let the caller decide to switch to a vision-driven /act flow.
//   3) { ok: true, action: 'critic.give_up', final_reason: '...' }
//        Stop retrying; emit user-facing failure summary.
//
// The rule engine below uses regex patterns on `error` heuristics to
// propose targeted patches. Anything we don't recognise falls back to
// `critic.fallback_vision` (preferred) or `critic.give_up`.
// ------------------------------------------------------------------

'use strict';

// Error → patch rules. Each rule returns either a mutated_dispatch (which
// re-runs the original dispatch with the patch merged into `data`) or null.
// The router appends `.K` to the task_id automatically.
const RULES = [
  // "element ... not found" / "timeout" → add a small pre-wait
  {
    id: 'add-pre-wait',
    test: (err) => /timeout|not\s+found|not\s+visible|assert_visible/i.test(err || ''),
    patch: (orig, err) => ({
      to: orig.to,
      action: orig.action,
      data: Object.assign({}, orig.data, { _critic_pre_wait_ms: 700 }),
    }),
  },
  // "Chat input not ready" / "did not render" → re-enter the chat
  {
    id: 're-enter-chat',
    test: (err) => /(chat|input)\s+(view|box)?\s*(did\s+not|not)\s+(render|ready)/i.test(err || ''),
    patch: (orig) => ({
      to: orig.to,
      action: orig.action,
      data: Object.assign({}, orig.data, { _critic_re_enter_chat: true }),
    }),
  },
  // Window not focused: ask for Alt+Tab first
  {
    id: 'alt-tab',
    test: (err) => /not\s+in\s+foreground|not\s+the\s+focused|window\s+is\s+not\s+focused/i.test(err || ''),
    patch: (orig) => ({
      to: orig.to,
      action: orig.action,
      data: Object.assign({}, orig.data, { _critic_alt_tab_first: true }),
    }),
  },
];

async function invoke(d) {
  if (d.action !== 'critic.propose_fix') {
    return { ok: false, error: 'critic_only_handles_propose_fix', got: d.action };
  }
  const original = d.data && d.data.original;
  const err = d.data && d.data.error;
  if (!original || !original.to) {
    // Critic has nothing to patch — explicitly give up.
    return {
      ok: true,
      agent: 'Critic',
      action: 'critic.give_up',
      final_reason: 'no_original_dispatch_provided',
    };
  }

  // Try rule list in order. First match wins.
  for (const rule of RULES) {
    if (rule.test(err)) {
      const mutated = rule.patch(original, err);
      return {
        ok: true,
        agent: 'Critic',
        action: 'critic.revised',
        rule: rule.id,
        mutated_dispatch: mutated,
      };
    }
  }

  // No rule matched → prefer vision fallback over giving up. Vision can
  // see the actual desktop state, so it's almost always worth one try.
  return {
    ok: true,
    agent: 'Critic',
    action: 'critic.fallback_vision',
    hint: err || 'no rule matched',
  };
}

module.exports = { invoke, RULES };
