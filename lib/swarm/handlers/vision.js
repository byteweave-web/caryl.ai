// lib/swarm/handlers/vision.js
// ------------------------------------------------------------------
// Vision agent: analyzes screen/camera frames for grounding.
// Allowed actions per prompts/orchestrator-system.md §5:
//   vision.ground, vision.ocr, vision.describe
//
// The real impl will forward to the existing camera:frame / vision:camera
// IPCs in main.js. Here we return a tagged stub so the swarm can run
// end-to-end while the real implementation lands.
// ------------------------------------------------------------------

'use strict';

const ALLOWED = ['ground', 'ocr', 'describe'];

async function invoke(d, vision) {
  const op = String(d.action || '').split('.').pop();
  if (!ALLOWED.includes(op)) {
    return { ok: false, error: 'unknown_vision_op', allowed: ALLOWED };
  }
  if (vision && typeof vision.invoke === 'function') {
    try {
      const out = await vision.invoke({ op, data: d.data || {} });
      return Object.assign({ ok: true, agent: 'Vision', op }, { result: out });
    } catch (e) {
      return { ok: false, agent: 'Vision', op, error: 'vision_threw: ' + (e.message || String(e)) };
    }
  }
  return {
    ok: true,
    agent: 'Vision',
    op,
    data: d.data || {},
    note: `Vision stub (${op}) — no real frame analysis yet.`,
    stub: true,
  };
}

module.exports = { invoke };
