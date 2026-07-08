// renderer/scene-watcher.js
// The ambient scene-watcher (spec D3 / Phase 6): cheap on-device frame-diff -> change gate
// -> ONE local-vision classification -> ONE suggestion. Pure, node-tested core up top
// (frameDelta / createGate / parseSceneReply / suggestionFor); createWatcher at the bottom
// is the only DOM-touching glue and takes every dependency injected, so tests and probes
// never need a webcam or a model. Dual-exported like the other shell cores.
(function (root) {
  'use strict';

  // Mean absolute grayscale difference, normalized 0..1. Conservative on bad input:
  // a missing/mismatched frame reads as "no change" (never a false suggestion).
  function frameDelta(a, b) {
    if (!a || !b || !a.length || a.length !== b.length) return 0;
    var sum = 0;
    for (var i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / (a.length * 255);
  }

  // Change gate (event-driven, not per-frame): a big delta marks "changed"; once deltas
  // stay calm for stableMs (you held the object steady) it fires EXACTLY once, then a
  // minimum interval must pass before anything can fire again.
  function createGate(opts) {
    opts = opts || {};
    var changeThreshold = typeof opts.changeThreshold === 'number' ? opts.changeThreshold : 0.085;
    var stableThreshold = typeof opts.stableThreshold === 'number' ? opts.stableThreshold : 0.03;
    var stableMs = typeof opts.stableMs === 'number' ? opts.stableMs : 1000;
    var minIntervalMs = typeof opts.minIntervalMs === 'number' ? opts.minIntervalMs : 20000;

    var stabilizing = false;
    var stableStart = null;
    var lastFire = -Infinity;

    return {
      feed: function (delta, now) {
        if (now - lastFire < minIntervalMs) return 'cooldown';
        if (!stabilizing) {
          if (delta >= changeThreshold) { stabilizing = true; stableStart = null; return 'changed'; }
          return 'idle';
        }
        if (delta >= stableThreshold) { stableStart = null; return 'stabilizing'; } // still moving
        if (stableStart === null) { stableStart = now; return 'stabilizing'; }
        if (now - stableStart >= stableMs) {
          stabilizing = false; stableStart = null; lastFire = now;
          return 'fire';
        }
        return 'stabilizing';
      },
    };
  }

  // Strict one-word confidence gate: only an exact scene word passes; 'none', prose,
  // or anything chatty is rejected (a wrong "I see a bill" is worse than silence).
  var SCENES = ['document', 'bill', 'product', 'whiteboard'];
  function parseSceneReply(text) {
    var t = String(text == null ? '' : text).trim().toLowerCase();
    t = t.replace(/^["'`\s]+/, '').replace(/["'`.,!\s]+$/, '');
    return SCENES.indexOf(t) >= 0 ? t : null;
  }

  var SUGGEST = {
    bill: { text: 'I see a bill — scan & log it?', question: 'This is a bill or invoice. Read it and log the vendor, date, total amount, and due date.' },
    document: { text: 'I see a document — read it?', question: 'Read this document and summarize the key points.' },
    product: { text: 'I see a product — identify it?', question: 'Identify this product and tell me anything useful about it.' },
    whiteboard: { text: 'I see a whiteboard — transcribe it?', question: 'Transcribe the whiteboard contents into clean notes.' },
  };
  function suggestionFor(scene) { return SUGGEST[scene] || null; }

  // --------------------------------------------------------------------------
  // Glue. The only part that touches the DOM (an offscreen canvas + the video).
  // --------------------------------------------------------------------------
  function createWatcher(opts) {
    opts = opts || {};
    var video = opts.video;
    var grabFrame = opts.grabFrame;
    var classify = opts.classify;
    var isBusy = opts.isBusy || function () { return false; };
    var onSuggest = opts.onSuggest || function () {};
    var onDisarm = opts.onDisarm || function () {};
    var sampleMs = opts.sampleMs || 500;
    var size = opts.size || { w: 64, h: 48 };
    var gate = createGate(opts.gate);
    var canvas = null, prev = null, timer = null, inflight = false, dead = false, isMuted = false;

    function gray() {
      if (!video || !video.videoWidth) return null;
      if (!canvas) { canvas = document.createElement('canvas'); canvas.width = size.w; canvas.height = size.h; }
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      try { ctx.drawImage(video, 0, 0, size.w, size.h); } catch (_e) { return null; }
      var d;
      try { d = ctx.getImageData(0, 0, size.w, size.h).data; } catch (_e) { return null; }
      var g = new Array(size.w * size.h);
      for (var i = 0, j = 0; i < d.length; i += 4, j++) g[j] = (d[i] + d[i + 1] + d[i + 2]) / 3;
      return g;
    }

    function sample() {
      if (dead || isMuted || inflight) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      if (isBusy()) { prev = null; return; } // don't diff across busy gaps
      var g = gray(); if (!g) return;
      if (prev && gate.feed(frameDelta(prev, g), Date.now()) === 'fire') fire();
      prev = g;
    }

    function fire() {
      inflight = true;
      Promise.resolve()
        .then(function () { return grabFrame(); })
        .then(function (frame) {
          return Promise.resolve(classify(frame)).then(function (reply) {
            var scene = parseSceneReply(reply);
            var s = scene && suggestionFor(scene);
            if (s) onSuggest({ scene: scene, frame: frame, text: s.text, question: s.question });
          });
        })
        .catch(function () {
          // Classification path broken (no model / network) -> disarm for this session.
          dead = true;
          try { onDisarm(); } catch (_e) {}
        })
        .then(function () { inflight = false; });
    }

    return {
      start: function () { dead = false; prev = null; if (!timer) timer = setInterval(sample, sampleMs); },
      stop: function () { if (timer) { clearInterval(timer); timer = null; } prev = null; },
      muted: function (m) { isMuted = !!m; if (isMuted) prev = null; },
      state: function () { return { running: !!timer, dead: dead, muted: isMuted, inflight: inflight }; },
    };
  }

  var api = { frameDelta: frameDelta, createGate: createGate, parseSceneReply: parseSceneReply, suggestionFor: suggestionFor, createWatcher: createWatcher, SCENES: SCENES };
  root.SceneWatcher = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
