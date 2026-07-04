// lib/kernel/index.js
// The Hybrid Automation Kernel orchestrator. Given a user's request it:
//   1. asks the Router to classify it against the TaskRegistry;
//   2. for a PURE_LOGIC / API_NATIVE match, hard-blocks the GUI for the turn and runs the
//      matching handler directly (the LLM is never consulted, the GUI is never touched);
//   3. for a miss (or a HYBRID_UIA match), returns { handled:false } so the caller
//      (main.js) runs its normal LLM / automation flow.
//
// This is the seam main.js wires into. It stays free of Electron so it tests under node.

const path = require('path');
const registryMod = require('./registry');
const router = require('./router');
const guard = require('./guard');
const math = require('./handlers/math');
const systemStats = require('./handlers/systemStats');
const weather = require('./handlers/weather');

// A math expression: either "X% of Y" or a chain of number-operator-number. This drives
// extraction (the substring the handler evaluates) and is the core of classification.
const MATH_EXPR =
  '(\\d+(?:\\.\\d+)?\\s*%\\s*of\\s*\\d+(?:\\.\\d+)?' +
  '|\\d+(?:\\.\\d+)?(?:\\s*[-+*/%]\\s*\\d+(?:\\.\\d+)?)+)';

// A bare MATH_EXPR is too eager: "9-5 job", "3-5 business days", "24/7 support" all contain
// number-operator-number and would misclassify as arithmetic. So the task only fires when
// EITHER an explicit calc cue precedes the expression, OR the whole message is essentially
// just the expression. The extractor still uses the bare MATH_EXPR to pull the value out.
const MATH_CUE = "(?:what(?:'s| is|s)|calculate|compute|evaluate|solve|how much is|=)";
const MATH_CUED = MATH_CUE + '\\s*' + MATH_EXPR;              // "what is 2 + 3", "calculate 15% of 200"
const MATH_WHOLE = '^\\s*' + MATH_EXPR + '\\s*[?.!]*\\s*$';   // "2 + 3", "12.5% of 340"

// Built-in tasks registered in code at startup. Learned recipes load from disk on top.
const BUILTINS = [
  {
    id: 'math.eval', title: 'Calculator', class: 'PURE_LOGIC', handler: 'builtin:math',
    matchers: [
      { type: 'regex', pattern: MATH_CUED },
      { type: 'regex', pattern: MATH_WHOLE }
    ],
    params: [{ name: 'expression', required: true, extractor: 'regex:' + MATH_EXPR }]
  },
  {
    id: 'sys.stats', title: 'System stats', class: 'PURE_LOGIC', handler: 'builtin:systemStats',
    matchers: [
      { type: 'keywords', all: ['system'], any: ['stats', 'status', 'info', 'usage', 'specs', 'resources'] },
      { type: 'keywords', any: ['cpu usage', 'ram usage', 'memory usage', 'disk space', 'system stats', 'system status', 'how much ram', 'how much memory'] }
    ],
    params: []
  },
  {
    // Whole-word 'weather'/'forecast' keeps this clear of the near-homograph "whether".
    id: 'weather.current', title: 'Weather', class: 'API_NATIVE', handler: 'builtin:weather',
    matchers: [{ type: 'keywords', any: ['weather', 'forecast'] }],
    params: [{ name: 'location', required: false, extractor: 'after:in|for|at' }]
  }
];

// handler id -> function(params, ctx) -> { ok, speak?, value?, overlay?, error? }
const HANDLERS = {
  'builtin:math': math.run,
  'builtin:systemStats': systemStats.run,
  'builtin:weather': weather.run
};

function createKernel(opts) {
  opts = opts || {};
  let registry = opts.registry;
  if (!registry) {
    const filePath = opts.filePath ||
      (opts.userDataDir ? path.join(opts.userDataDir, 'task-registry.json') : null);
    registry = registryMod.createRegistry({ filePath, builtins: BUILTINS, logger: opts.logger });
  }
  const handlers = Object.assign({}, HANDLERS, opts.handlers);
  const getConfig = (typeof opts.getConfig === 'function') ? opts.getConfig : null;
  const fetchImpl = opts.fetchImpl || null; // injected in tests; prod uses global fetch

  // handle(text) -> { handled, class?, entry?, params?, result? }
  // handled:false means "not a kernel task — run your normal flow".
  async function handle(text) {
    const match = router.classify(text, registry.all());
    if (!match) return { handled: false };

    // Logic/API task: block the GUI for the turn, run the handler, always release.
    if (match.guiBlocked) {
      guard.block('task "' + match.entry.id + '" is ' + match.class);
      try {
        const fn = handlers[match.entry.handler];
        if (typeof fn !== 'function') {
          return { handled: false, reason: 'no-handler', entry: match.entry };
        }
        if (match.needs && match.needs.length) {
          return {
            handled: true, class: match.class, entry: match.entry, params: match.params,
            result: { ok: false, needs: match.needs, error: 'I need: ' + match.needs.join(', ') }
          };
        }
        const ctx = { text, config: getConfig ? getConfig() : undefined, fetch: fetchImpl || undefined };
        const result = await fn(match.params, ctx);
        registry.touch(match.entry.id, { success: !!(result && result.ok) });
        return { handled: true, class: match.class, entry: match.entry, params: match.params, result };
      } finally {
        guard.unblock();
      }
    }

    // HYBRID_UIA match: the Kernel doesn't execute it — main.js delegates to the
    // automation loop (Sub-project B). Surface the match so the caller can use it.
    return { handled: false, hybrid: true, entry: match.entry, match };
  }

  return { handle, registry };
}

module.exports = { createKernel, BUILTINS, HANDLERS, MATH_EXPR };
