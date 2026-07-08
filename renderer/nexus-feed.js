// renderer/nexus-feed.js
// Pure, DOM-free brain of the Live Orb: turns raw inputs (voice flags, mic RMS, TTS
// envelope, ai_status, swarm events) into a display state + task directives for the
// embedded Nexus deck. Dual-exported: window.NexusFeed (renderer <script>) AND
// module.exports (node tests) — same pattern as renderer/shell-reducer.js.
// Same input -> same output; the caller supplies `now` (ms) so nothing here ticks.
(function (root) {
  'use strict';

  var TASK_TIMEOUT_MS = 90000; // leaked dispatch auto-returns (spec §10)
  var LEVEL_FRESH_MS = 400;    // audio level older than this reads as silence

  // Router alphabet (TitleCase) -> deck roster (UPPERCASE). Orchestrator IS the core
  // (note, no packet); PLANNER has no live source yet (spec §8).
  var SWARM_TO_ROSTER = {
    RESEARCHER: 'RESEARCHER', EXECUTOR: 'EXECUTOR', CODER: 'CODER',
    MEMORY: 'MEMORY', VISION: 'VISION', CRITIC: 'CRITIC',
  };

  function clamp01(n) { n = +n; if (!(n > 0)) return 0; return n > 1 ? 1 : n; }

  // Floor-relative mic curve: silence at 1.5x the ambient floor, full glow at 8x,
  // so the swell reads the same in a quiet or a noisy room.
  function normalizeMicLevel(rms, floor) {
    var f = +floor; if (!(f > 0.003)) f = 0.003;
    var lo = f * 1.5, hi = f * 8;
    var n = ((+rms || 0) - lo) / (hi - lo);
    return n <= 0 ? 0 : n >= 1 ? 1 : n;
  }

  function createFeed() {
    var inputs = {
      recording: false, lwCapturing: false, conversationOpen: false, graceArmed: false,
      ttsPlaying: false, aiStatus: 'idle', automationRunning: false, offline: false,
    };
    var lvl = { mic: 0, micAt: -1e9, tts: 0, ttsAt: -1e9 };
    var open = {}; // id -> { agent, at, endOn }

    function taskBegin(key, agent, label, opts, now) {
      if (open[key]) { open[key].at = now; return []; } // refresh, don't stack
      open[key] = { agent: agent, at: now, endOn: (opts && opts.endOn) || 'event' };
      return [{ op: 'dispatch', agent: agent, id: key, label: label || '' }];
    }
    function taskEnd(key, ok, now) {
      var rec = open[key];
      if (!rec) return [];
      delete open[key];
      return [{ op: 'return', agent: rec.agent, id: key, ok: ok !== false }];
    }

    function setInputs(partial, now) {
      var prev = { automationRunning: inputs.automationRunning, aiStatus: inputs.aiStatus };
      var k; for (k in partial) if (Object.prototype.hasOwnProperty.call(partial, k)) inputs[k] = partial[k];
      var out = [];
      // Automation lifecycle rides the status-poll edge -> EXECUTOR.
      if (!prev.automationRunning && inputs.automationRunning) {
        out = out.concat(taskBegin('automation', 'EXECUTOR', 'automation run', { endOn: 'automation' }, now));
      } else if (prev.automationRunning && !inputs.automationRunning) {
        out = out.concat(taskEnd('automation', true, now));
      }
      // ai-idle-scoped tasks (camera asks) close when the AI turn ends.
      var wasBusy = prev.aiStatus === 'thinking' || prev.aiStatus === 'working' || prev.aiStatus === 'researching';
      var isBusy = inputs.aiStatus === 'thinking' || inputs.aiStatus === 'working' || inputs.aiStatus === 'researching';
      if (wasBusy && !isBusy) {
        Object.keys(open).forEach(function (id) {
          if (open[id].endOn === 'ai-idle') out = out.concat(taskEnd(id, true, now));
        });
      }
      return out;
    }

    function computeState(now) {
      var i = inputs, mode, text;
      if (i.ttsPlaying) { mode = 'speaking'; text = 'speaking'; }
      else if (i.recording || i.lwCapturing || i.aiStatus === 'listening') { mode = 'listening'; text = 'listening'; }
      else if (i.aiStatus === 'thinking') { mode = 'busy'; text = 'thinking'; }
      else if (i.aiStatus === 'working' || i.aiStatus === 'researching' || i.automationRunning) { mode = 'busy'; text = 'working on it'; }
      else if (i.conversationOpen || i.graceArmed) { mode = 'attentive'; text = 'attentive'; }
      else { mode = 'idle'; text = 'idle'; }
      if (i.offline) { mode = 'idle'; text = 'offline'; }
      var level = 0, levelSrc = 'none';
      if (i.offline) {
        // offline reads as dead: never glow, even if a recent mic sample is still fresh
      } else if (mode === 'speaking') {
        if (now - lvl.ttsAt < LEVEL_FRESH_MS) { level = lvl.tts; levelSrc = 'tts'; }
      } else if (now - lvl.micAt < LEVEL_FRESH_MS) { level = lvl.mic; levelSrc = 'mic'; }
      return { mode: mode, text: text, level: level, levelSrc: levelSrc };
    }

    function swarmEvent(ev, now) {
      if (!ev || typeof ev !== 'object') return [];
      var kind = ev.kind, id = String(ev.task_id || '');
      if (kind === 'dispatch-rejected') return [{ op: 'reject', id: id, label: 'rejected' }];
      if (kind === 'dispatch-rate-limited') return [{ op: 'reject', id: id, label: 'rate-limited' }];
      var up = String(ev.to || '').toUpperCase();
      if (up === 'ORCHESTRATOR') {
        return kind === 'dispatch-start' ? [{ op: 'note', id: id, label: String(ev.action || 'orchestrate') }] : [];
      }
      var agent = SWARM_TO_ROSTER[up];
      if (!agent) return [];
      var key = id + '·' + agent;
      if (kind === 'dispatch-start') return taskBegin(key, agent, String(ev.action || ''), { endOn: 'event' }, now);
      if (kind === 'dispatch-end') {
        var out = taskEnd(key, ev.ok === true, now);
        // end-without-start still shows a return pulse — harmless and honest (spec §10)
        return out.length ? out : [{ op: 'return', agent: agent, id: key, ok: ev.ok === true }];
      }
      return [];
    }

    function sweep(now) {
      var out = [];
      Object.keys(open).forEach(function (id) {
        if (now - open[id].at >= TASK_TIMEOUT_MS) {
          var agent = open[id].agent;
          delete open[id];
          out.push({ op: 'return', agent: agent, id: id, ok: false });
        }
      });
      return out;
    }

    return {
      setInputs: setInputs,
      micLevel: function (rms, floor, now) { lvl.mic = normalizeMicLevel(rms, floor); lvl.micAt = now; },
      ttsLevel: function (v, now) { lvl.tts = clamp01(v); lvl.ttsAt = now; },
      computeState: computeState,
      swarmEvent: swarmEvent,
      taskBegin: taskBegin,
      taskEnd: taskEnd,
      sweep: sweep,
      openCount: function () { return Object.keys(open).length; },
    };
  }

  var api = {
    createFeed: createFeed,
    normalizeMicLevel: normalizeMicLevel,
    TASK_TIMEOUT_MS: TASK_TIMEOUT_MS,
    LEVEL_FRESH_MS: LEVEL_FRESH_MS,
  };
  root.NexusFeed = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
