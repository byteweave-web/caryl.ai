// tests/test-swarm-router.js
// ------------------------------------------------------------------
// Smoke tests for the 7-agent swarm router. Pure Node, no Electron.
// Run: node tests/test-swarm-router.js
//
// What we verify:
//   1) validate() rejects unknown `to` and self-dispatch to Orchestrator
//   2) dispatch() returns the handler result and emits a stream
//      (start, then end) on the emitter BEFORE awaiting the handler
//      completes (the renderer needs that for in-flight animations)
//   3) parseDispatchPayloads splits JSONL correctly, ignoring prose
//   4) dispatchWithCritic retries up to N times; each retry's task_id
//      is the previous id with the suffix stripped then .K appended
//   5) critic.propose_fix returns mutated_dispatch; the retry uses it
//   6) critic.give_up short-circuits the retry loop
// ------------------------------------------------------------------

'use strict';

const assert = require('assert');
const { SwarmRouter, stripRetrySuffix, topologicalOrder, ALLOWED_AGENTS } = require('../lib/swarm/router');
const { buildRegistry } = require('../lib/swarm/handlers');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  PASS', name); }
  catch (e) { fail++; console.log('  FAIL', name + ' -> ' + (e && e.message ? e.message : e)); }
}

(async function main() {
  console.log('Swarm Router tests');

  // ---- Test 1: validate() rejects bad payloads ----
  test('validate rejects unknown to', () => {
    const r = new SwarmRouter();
    assert.strictEqual(r.validate({ to: 'EvilBot', action: 'noop' }).error, 'unknown_to');
  });
  test('validate rejects Orchestrator (self-dispatch forbidden)', () => {
    const r = new SwarmRouter();
    assert.strictEqual(r.validate({ to: 'Orchestrator', action: 'noop' }).error, 'self_dispatch_forbidden');
    assert.ok(ALLOWED_AGENTS.includes('Orchestrator'),
      'Orchestrator is in the alphabet (the router just refuses self-dispatch)');
  });
  test('validate rejects missing action', () => {
    const r = new SwarmRouter();
    assert.ok(/missing_action|self_dispatch|unknown_to/.test(r.validate({ to: 'Researcher' }).error || ''));
  });
  test('validate rejects non-object payloads', () => {
    const r = new SwarmRouter();
    assert.strictEqual(r.validate(null).error, 'dispatch_not_object');
    assert.strictEqual(r.validate('hello').error, 'dispatch_not_object');
    assert.strictEqual(r.validate([1,2,3]).error, 'dispatch_not_object');
  });

  // ---- Test 2: dispatch() streams + happy path ----
  test('dispatch returns handler result and emits start-then-end', async () => {
    const events = [];
    const router = new SwarmRouter({
      registry: buildRegistry({
        executorInvoke: async () => ({ ok: true, agent: 'Executor', note: 'hi' }),
      }),
      emitter: (ev) => events.push(ev),
    });
    const res = await router.dispatch({ to: 'Executor', task_id: 't-001', action: 'send_whatsapp_message', data: { contact_name: 'Mom', message_text: 'hi' } });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.agent, 'Executor');
    // events: dispatch-start, dispatch-end  -- order matters
    const kinds = events.map(e => e.kind);
    assert.deepStrictEqual(kinds, ['dispatch-start', 'dispatch-end']);
    assert.strictEqual(events[0].to, 'Executor');
    assert.strictEqual(events[0].action, 'send_whatsapp_message');
    assert.strictEqual(events[1].ok, true);
  });

  test('dispatch-start fires BEFORE the handler resolves', async () => {
    let startedAt = -1;
    const events = [];
    const router = new SwarmRouter({
      registry: buildRegistry({
        executorInvoke: async () => {
          startedAt = Date.now();
          await new Promise(r => setTimeout(r, 50));
          return { ok: true };
        },
      }),
      emitter: (ev) => { if (ev.kind === 'dispatch-start') events.push({ kind: 'start', t: Date.now() }); },
    });
    const before = Date.now();
    await router.dispatch({ to: 'Executor', task_id: 't-002', action: 'spotify_next_track' });
    // The dispatch-start event was emitted synchronously BEFORE the handler
    // was even invoked - so events[0].t should be <= startedAt.
    assert.ok(events.length === 1 && events[0].t <= startedAt && events[0].t >= before,
      'start event fires before handler starts');
  });

  // ---- Test 3: parseDispatchPayloads ----
  test('parseDispatchPayloads splits JSONL correctly', () => {
    const raw = [
      '<plan>',
      '1. Decompose: send WhatsApp',
      '2. Assign: Executor',
      '</plan>',
      '{"to":"Executor","task_id":"t-001","action":"send_whatsapp_message","data":{}}',
      '{"to":"Critic","task_id":"crit-001","action":"critic.propose_fix","data":{}}',
    ].join('\n');
    const out = SwarmRouter.parseDispatchPayloads(raw);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].action, 'send_whatsapp_message');
    assert.strictEqual(out[1].action, 'critic.propose_fix');
  });

  test('parseDispatchPayloads tolerates trailing prose', () => {
    const raw = '{"to":"Executor","task_id":"t-a","action":"x","data":{}}\nMaterial written here is fine.';
    const out = SwarmRouter.parseDispatchPayloads(raw);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].task_id, 't-a');
  });

  // ---- Test 4: stripRetrySuffix ----
  test('stripRetrySuffix strips trailing .K from existing retries', () => {
    assert.strictEqual(stripRetrySuffix('t-001'), 't-001');
    assert.strictEqual(stripRetrySuffix('t-001.1'), 't-001');
    assert.strictEqual(stripRetrySuffix('t-001.1.2'), 't-001.1');
    assert.strictEqual(stripRetrySuffix('crit-001'), 'crit-001');
    assert.strictEqual(stripRetrySuffix('crit-001.3'), 'crit-001');
  });

  // ---- Test 5: dispatchWithCritic retries with FIXED task_id ----
  test('dispatchWithCritic retries with base id + .K, not stacked suffixes', async () => {
    let tryCount = 0;
    const events = [];
    const router = new SwarmRouter({
      registry: buildRegistry({
        executorInvoke: async () => {
          tryCount += 1;
          if (tryCount < 3) return { ok: false, error: 'simulated_timeout' };
          return { ok: true, agent: 'Executor' };
        },
      }),
      emitter: (ev) => events.push(ev),
    });
    const result = await router.dispatchWithCritic(
      { to: 'Executor', task_id: 't-099', action: 'send_whatsapp_message', data: {} },
      { maxRetries: 3 }
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.attempts, 3);
    // The task_ids of the dispatched payloads should be t-099, t-099.1, t-099.2
    // (NOT t-099, t-099.1, t-099.1.2).
    const exStarts = events.filter(e => e.kind === 'dispatch-start' && e.to === 'Executor');
    assert.deepStrictEqual(exStarts.map(e => e.task_id), ['t-099', 't-099.1', 't-099.2']);
  });

  test('critic.revised mutated_dispatch is used verbatim (only task_id is rewritten)', async () => {
    let tryCount = 0;
    let lastData = null;
    const router = new SwarmRouter({
      registry: buildRegistry({
        executorInvoke: async (d) => {
          tryCount += 1;
          lastData = d.data;
          if (tryCount < 2) return { ok: false, error: 'simulated_timeout' };
          return { ok: true };
        },
      }),
      emitter: () => {},
    });
    // Override Critic to return a known patch (wait 700ms before retry).
    router.registry.Critic = async (d) => {
      if (d.action !== 'critic.propose_fix') return { ok: false };
      return { ok: true, agent: 'Critic', action: 'critic.revised',
        rule: 'add-pre-wait', mutated_dispatch: {
          to: d.data.original.to,
          action: d.data.original.action,
          data: Object.assign({}, d.data.original.data, { _critic_pre_wait_ms: 700 }),
        } };
    };
    const r = await router.dispatchWithCritic(
      { to: 'Executor', task_id: 't-fix', action: 'send_whatsapp_message', data: { contact_name: 'Mom' } }
    );
    assert.strictEqual(r.ok, true);
    // The patched dispatcher should have seen the new flag on its 2nd try.
    assert.strictEqual(lastData._critic_pre_wait_ms, 700, 'critic patch made it into the retry');
  });

  test('critic.give_up short-circuits the retry loop', async () => {
    const router = new SwarmRouter({
      registry: buildRegistry({
        executorInvoke: async () => ({ ok: false, error: 'simulated' }),
      }),
      emitter: () => {},
    });
    router.registry.Critic = async () => ({ ok: true, agent: 'Critic', action: 'critic.give_up', final_reason: 'gave up' });
    const r = await router.dispatchWithCritic({ to: 'Executor', action: 'x', data: {} }, { maxRetries: 3 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.critic, 'give_up');
    assert.strictEqual(r.attempts, 1); // failed once, gave up, never retried
    assert.strictEqual(r.error, 'simulated');
  });

  // ---- Test 6: dispatchChain runs payloads in dependency order ----
  test('dispatchChain runs independent payloads in any order and dependents after', async () => {
    const runs = [];
    const router = new SwarmRouter({
      registry: buildRegistry({
        executorInvoke: async (d) => {
          runs.push(d.task_id);
          return { ok: true };
        },
      }),
      emitter: () => {},
    });
    const result = await router.dispatchChain([
      { to: 'Executor', task_id: 'a', action: 'send_whatsapp_message', data: {} },
      { to: 'Executor', task_id: 'b', action: 'send_whatsapp_message', data: {},
        depends_on: ['a']
      },
      { to: 'Executor', task_id: 'c', action: 'send_whatsapp_message', data: {} },
    ]);
    assert.strictEqual(result.ok, true);
    // 'b' must come AFTER 'a' (it's a dependent). 'c' is independent; order
    // between c and the others isn't strictly pinned, but 'a' < 'b' is.
    assert.ok(runs.indexOf('a') < runs.indexOf('b'),
      'dependent (b) runs after dependency (a)');
  });

  // ---- Test 7: validate data shape ----
  test('validate rejects bad data field', () => {
    const r = new SwarmRouter();
    assert.strictEqual(r.validate({ to: 'Executor', action: 'x', data: 'wrong' }).error, 'bad_data');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
