/* wakeword.js - local "Hey Jarvis" detection with openWakeWord + onnxruntime-web.
 *
 * Pipeline (all on-device, no cloud): mic @16kHz -> melspectrogram model -> Google speech
 * embedding model -> "hey jarvis" classifier -> score. When the score crosses the threshold we
 * fire onDetect(); index.html then records one command and sends it to Whisper.
 *
 * Requires a global `ort` (onnxruntime-web, loaded from CDN in index.html) and window.bridge
 * (to fetch the downloaded model bytes). Exposes a global `WakeWord`.
 *
 * Shapes (confirmed from openWakeWord): melspec in [1,1280] f32 (int16-range audio) -> mel
 * frames x32; embedding in [1,76,32,1] -> [1,1,1,96]; classifier in [1,16,96] -> [1,1] score.
 */
(function () {
  const STEP = 1280;          // audio samples per step (80 ms @ 16 kHz)
  const MEL_BINS = 32;
  const EMB_WINDOW = 76;      // mel frames per embedding
  const WW_FRAMES = 16;       // embeddings per classifier prediction
  const EMB_DIM = 96;
  const COOLDOWN_MS = 2500;   // ignore repeat fires within this window

  let ort = null;
  let melSession = null, embSession = null, wwSession = null;
  let audioCtx = null, source = null, processor = null, stream = null, sinkEl = null;
  let inRate = 16000; // actual hardware sample rate; we downsample this to 16k ourselves
  let running = false, loaded = false;
  let threshold = 0.5;
  let lastDetect = 0;
  let wwModelName = 'hey_jarvis_v0.1.onnx'; // which classifier to run; set via start({model})
  // ===== Smart Audio & Voice Interaction (4:4 Speaker Recognition) =====
  // userPrint, when set, is a 96-dim Float32Array mean-pool centroid of the user's voice from
  // onboarding. Every successful detection computes the cosine similarity of the same 96-dim
  // window against userPrint; if `sim < userPrintThreshold` we suppress cb.detect silently -
  // the wake word fizzles into the background instead of the mic for a partial-misfire.
  let userPrint = null;
  let userPrintThreshold = 0.70;
  // enrollmentOnly: when set by onboarding, every successful detect fires cb.embedCapture so
  // the renderer can mean-pool the live embedding into the saved print. Detects fire normally.
  let enrollmentOnly = false;

  // Mean-pool 16 frames x 96 dims -> 96 dims. Each frame is a snapshot of the speech-embedding
  // model's output around the wake-word trigger; one wake utterance yields 16 of them.
  function meanPool(frames) {
    if (!Array.isArray(frames) || !frames.length) return null;
    const n = frames.length;
    const d = frames[0].length || EMB_DIM;
    const out = new Float32Array(d);
    for (let i = 0; i < n; i++) {
      const f = frames[i];
      if (!f || f.length !== d) continue;
      for (let j = 0; j < d; j++) out[j] += f[j] / n;
    }
    return out;
  }
  function cosineSim(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const m = Math.sqrt(na) * Math.sqrt(nb);
    return m ? dot / m : 0;
  }

  // rolling buffers
  let pcm = new Float32Array(0);       // leftover audio samples not yet stepped
  let melBuffer = [];                  // array of Float32Array(32)
  let embBuffer = [];                  // array of Float32Array(96)

  const cb = { status: function () { }, detect: function () { }, error: function () { }, ready: function () { }, score: function () { }, level: function () { }, embedCapture: function () { } };
  const _dbg = { mel: false, emb: false, ww: false, peak: 0, peakAt: 0, rms: 0, melSample: '' };

  function log() { try { console.log.apply(console, ['[wakeword]'].concat([].slice.call(arguments))); } catch (e) { } }
  function status(s) { try { cb.status(s); } catch (e) { } log(s); }

  // Resample a Float32 buffer from the hardware rate down to 16 kHz (linear interpolation).
  function downsampleTo16k(buf, rate) {
    if (rate === 16000) return buf;
    const ratio = rate / 16000;
    const outLen = Math.floor(buf.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const idx = i * ratio;
      const i0 = Math.floor(idx);
      const i1 = i0 + 1 < buf.length ? i0 + 1 : buf.length - 1;
      const frac = idx - i0;
      out[i] = buf[i0] * (1 - frac) + buf[i1] * frac;
    }
    return out;
  }

  async function makeSession(name) {
    const r = await window.bridge.wakewordModel(name);
    if (!r || !r.ok) throw new Error('model "' + name + '": ' + ((r && r.error) || 'unavailable'));
    return ort.InferenceSession.create(new Uint8Array(r.bytes), { executionProviders: ['wasm'] });
  }

  async function load() {
    if (loaded) return;
    if (typeof ort === 'undefined' || !ort) { ort = window.ort; }
    if (!ort) throw new Error('onnxruntime-web (ort) not loaded');
    // single-threaded wasm: no SharedArrayBuffer / COOP-COEP needed under file://
    try { ort.env.wasm.numThreads = 1; ort.env.wasm.simd = true; } catch (e) { }
    status('Loading wake-word models\u2026');
    melSession = await makeSession('melspectrogram.onnx');
    embSession = await makeSession('embedding_model.onnx');
    wwSession = await makeSession(wwModelName);
    loaded = true;
    status('Wake-word models ready.');
    try { cb.ready(); } catch (e) { }
  }

  // ---- inference helpers ----
  async function melspec(step1280) {
    // audio scaled to int16 amplitude range, as openWakeWord expects
    const x = new Float32Array(step1280.length);
    for (let i = 0; i < step1280.length; i++) x[i] = step1280[i] * 32767;
    const inName = melSession.inputNames[0], outName = melSession.outputNames[0];
    const t = new ort.Tensor('float32', x, [1, x.length]);
    const out = await melSession.run({ [inName]: t });
    const o = out[outName];
    const dims = o.dims, data = o.data;
    if (!_dbg.mel) { _dbg.mel = true; log('melspec output dims =', JSON.stringify(dims), 'len =', data.length); }
    // dims are [1,1,T,32] or [1,T,32]; find T
    const T = dims.length === 4 ? dims[2] : dims[1];
    const frames = [];
    for (let f = 0; f < T; f++) {
      const row = new Float32Array(MEL_BINS);
      for (let b = 0; b < MEL_BINS; b++) row[b] = data[f * MEL_BINS + b] / 10 + 2; // openWakeWord transform
      frames.push(row);
    }
    return frames;
  }

  async function embed(last76) {
    const data = new Float32Array(EMB_WINDOW * MEL_BINS);
    for (let f = 0; f < EMB_WINDOW; f++) data.set(last76[f], f * MEL_BINS);
    const inName = embSession.inputNames[0], outName = embSession.outputNames[0];
    const t = new ort.Tensor('float32', data, [1, EMB_WINDOW, MEL_BINS, 1]);
    const out = await embSession.run({ [inName]: t });
    if (!_dbg.emb) { _dbg.emb = true; log('embedding output len =', out[outName].data.length, 'dims =', JSON.stringify(out[outName].dims)); }
    return out[outName].data; // 96 floats
  }

  async function classify(last16) {
    const data = new Float32Array(WW_FRAMES * EMB_DIM);
    for (let i = 0; i < WW_FRAMES; i++) data.set(last16[i], i * EMB_DIM);
    const inName = wwSession.inputNames[0], outName = wwSession.outputNames[0];
    const t = new ort.Tensor('float32', data, [1, WW_FRAMES, EMB_DIM]);
    const out = await wwSession.run({ [inName]: t });
    if (!_dbg.ww) { _dbg.ww = true; log('classifier output dims =', JSON.stringify(out[outName].dims)); }
    return out[outName].data[0];
  }

  // process exactly one 1280-sample step through the whole pipeline
  let busy = false;
  async function processStep(step) {
    // measure input loudness so we can tell if the mic is actually feeding us audio
    let ss = 0; for (let i = 0; i < step.length; i++) ss += step[i] * step[i];
    const rms = Math.sqrt(ss / step.length);
    if (rms > _dbg.rms) _dbg.rms = rms;
    try { cb.level(rms); } catch (e) { }   // real-time level, used by the post-detect command VAD

    const frames = await melspec(step);
    if (frames.length) _dbg.melSample = Array.prototype.slice.call(frames[frames.length - 1], 0, 4).map(function (v) { return v.toFixed(2); }).join(',');
    for (let i = 0; i < frames.length; i++) melBuffer.push(frames[i]);
    if (melBuffer.length > 400) melBuffer = melBuffer.slice(melBuffer.length - 400);
    if (melBuffer.length < EMB_WINDOW) return;

    const emb = await embed(melBuffer.slice(melBuffer.length - EMB_WINDOW));
    embBuffer.push(Float32Array.from(emb));
    if (embBuffer.length > 64) embBuffer = embBuffer.slice(embBuffer.length - 64);
    if (embBuffer.length < WW_FRAMES) return;

    const score = await classify(embBuffer.slice(embBuffer.length - WW_FRAMES));
    try { cb.score(score); } catch (e) { }
    if (score > _dbg.peak) _dbg.peak = score;
    const tnow = Date.now();
    if (tnow - _dbg.peakAt > 1000) { log('score=' + _dbg.peak.toFixed(3) + ' | audioRMS=' + _dbg.rms.toFixed(4) + ' | mel[0..3]=' + (_dbg.melSample || '?')); _dbg.peak = 0; _dbg.rms = 0; _dbg.peakAt = tnow; }
    const now = Date.now();
    if (score >= threshold && (now - lastDetect) > COOLDOWN_MS) {
      lastDetect = now;
      // Snapshot the 16 most-recent embeddings BEFORE we reset embBuffer. The window covers
      // exactly the frames the classifier saw, so the mean-pool is the per-utterance "voice
      // fingerprint" the speaker-recognition feature uses.
      const frameSnapshot = embBuffer.slice(-WW_FRAMES);
      embBuffer = [];        // reset so we don't re-fire on the same utterance
      log('DETECTED ' + wwModelName + ' score=' + score.toFixed(3));

      // (4) Speaker verification - silent veto when the live embedding cosine-sim against
      // the saved print falls below the threshold. Keeps COOLDOWN quiet so we don't keep
      // firing for the same impersonation attempt.
      if (userPrint && userPrint.length === EMB_DIM) {
        const live = meanPool(frameSnapshot);
        if (live) {
          const sim = cosineSim(live, userPrint);
          if (sim < userPrintThreshold) {
            log('[voice] print mismatch sim=' + sim.toFixed(2) + ' - suppressed');
            // Don't fire detect, but DO still report embedCapture so enrollment tracking stays in sync.
            try { cb.embedCapture({ frames: frameSnapshot, sim: sim, matched: false }); } catch (e) { }
            return;
          }
          log('[voice] print match sim=' + sim.toFixed(2));
        }
      }
      try { cb.detect(score); } catch (e) { }
      if (enrollmentOnly) {
        try { cb.embedCapture({ frames: frameSnapshot, sim: -1, matched: true }); } catch (e) { }
      }
    }
  }

  function feedSamples(raw) {
    if (!running || !raw || !raw.length) return;
    const inBuf = downsampleTo16k(raw, inRate); // native rate -> 16 kHz
    // append to leftover pcm
    const merged = new Float32Array(pcm.length + inBuf.length);
    merged.set(pcm, 0); merged.set(inBuf, pcm.length);
    pcm = merged;
    // drain in 1280-sample steps (sequentially; skip if a step is still running)
    if (busy) return;
    busy = true;
    (async function () {
      try {
        while (pcm.length >= STEP) {
          const step = pcm.slice(0, STEP);
          pcm = pcm.slice(STEP);
          await processStep(step);
          if (!running) break;
        }
      } catch (err) {
        log('step error', err);
        try { cb.error(err); } catch (e) { }
      } finally { busy = false; }
    })();
  }

  const WakeWord = {
    get running() { return running; },
    get stream() { return stream; },     // index.html records the command from this same stream
    setThreshold: function (v) { threshold = Math.max(0.05, Math.min(0.95, Number(v) || 0.5)); },
    on: function (evt, fn) { if (cb.hasOwnProperty(evt) && typeof fn === 'function') cb[evt] = fn; return this; },

    // Download (if needed) + load models, then open the mic and start detecting.
    start: async function (opts) {
      if (running) return;
      opts = opts || {};
      if (typeof opts.threshold === 'number') this.setThreshold(opts.threshold);
      if (opts.model && opts.model !== wwModelName) { wwModelName = String(opts.model); loaded = false; } // switch classifier -> rebuild sessions
      // (4) Speaker print wiring - the renderer passes the user's saved centroid + threshold,
      // plus an enrollmentOnly flag during onboarding so every detection captures embeddings.
      try { if (opts.userPrint && opts.userPrint.length === EMB_DIM) userPrint = opts.userPrint; else userPrint = null; } catch (e) { userPrint = null; }
      if (typeof opts.userPrintThreshold === 'number') userPrintThreshold = Math.max(0.4, Math.min(0.95, opts.userPrintThreshold));
      enrollmentOnly = !!opts.enrollmentOnly;
      try {
        status('Preparing wake-word models\u2026');
        const ens = await window.bridge.wakewordEnsure();
        if (!ens || !ens.ok) throw new Error((ens && ens.error) || 'could not download models');
        await load();

        status('Opening microphone\u2026');
        // Use the SAME microphone the rest of the app uses (Settings -> Active Input Device),
        // not whatever Windows considers the "default" device. This was the actual bug: every
        // other capture path in the app requests this exact deviceId; the wake engine was the
        // only one that didn't, so on machines where the OS default isn't the chosen mic, it
        // silently opened a different (often silent/unused) device - hence audioRMS staying at
        // exactly 0 no matter what else changed.
        let micId = '';
        try { micId = localStorage.getItem('micDeviceId') || ''; } catch (e) { }
        const audioConstraints = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
        if (micId) audioConstraints.deviceId = { exact: micId };
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        log('using mic deviceId =', micId || '(none saved - used OS default)');

        // Chromium quirk: a getUserMedia stream fed into Web Audio often delivers SILENCE unless
        // the same stream is also sunk into a muted, playing <audio> element. This "primes" it.
        try {
          sinkEl = document.createElement('audio');
          sinkEl.srcObject = stream;
          sinkEl.muted = true;
          sinkEl.setAttribute('playsinline', '');
          await sinkEl.play().catch(function () { });
        } catch (e) { }

        audioCtx = new (window.AudioContext || window.webkitAudioContext)(); // native rate; we downsample to 16k
        if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch (e) { } }
        inRate = audioCtx.sampleRate || 48000;
        log('audio context sample rate =', inRate);
        source = audioCtx.createMediaStreamSource(stream);

        // Modern capture path: an AudioWorklet that buffers ~2048 samples and posts them to us.
        // (ScriptProcessorNode is deprecated and delivers SILENT buffers on recent Chromium/Electron.)
        const workletCode =
          'class WWProc extends AudioWorkletProcessor{' +
          'constructor(){super();this._b=[];this._n=0;}' +
          'process(inputs){var ch=inputs[0]&&inputs[0][0];' +
          'if(ch&&ch.length){this._b.push(ch.slice(0));this._n+=ch.length;' +
          'if(this._n>=2048){var out=new Float32Array(this._n),o=0,i;for(i=0;i<this._b.length;i++){out.set(this._b[i],o);o+=this._b[i].length;}' +
          'this.port.postMessage(out,[out.buffer]);this._b=[];this._n=0;}}return true;}}' +
          'registerProcessor("ww-proc",WWProc);';
        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await audioCtx.audioWorklet.addModule(url);
        try { URL.revokeObjectURL(url); } catch (e) { }
        processor = new AudioWorkletNode(audioCtx, 'ww-proc');
        processor.port.onmessage = function (e) { feedSamples(e.data); };
        source.connect(processor);
        processor.connect(audioCtx.destination);
        melBuffer = []; embBuffer = []; pcm = new Float32Array(0);
        running = true;
        status('Listening for the wake word\u2026');
      } catch (e) {
        running = false;
        status('Wake word off (' + ((e && e.message) || e) + ')');
        try { cb.error(e); } catch (_e) { }
        this.stop();
        throw e;
      }
    },

    stop: function () {
      running = false;
      // (4) Clear speaker state when the detector stops, so re-arming without a fresh print
      // explicitly means the next session won't gate on the old (potentially stale) centroid.
      userPrint = null;
      enrollmentOnly = false;
      try { if (processor) { processor.port.onmessage = null; processor.disconnect(); } } catch (e) { }
      try { if (source) source.disconnect(); } catch (e) { }
      try { if (audioCtx) audioCtx.close(); } catch (e) { }
      try { if (sinkEl) { sinkEl.pause(); sinkEl.srcObject = null; } } catch (e) { }
      try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { }
      processor = null; source = null; audioCtx = null; stream = null; sinkEl = null;
      pcm = new Float32Array(0); melBuffer = []; embBuffer = [];
      status('Wake word stopped.');
    }
  };

  // Expose the canonical helpers on the public object so consumers
  // (onboarding.html, settings page) can reuse them instead of duplicating.
  // Single source of truth: these names are the public API - rename here with care.
  WakeWord.meanPool = meanPool;
  WakeWord.cosineSim = cosineSim;

  window.WakeWord = WakeWord;
})();