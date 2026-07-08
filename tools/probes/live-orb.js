(async function () {
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
  var out = {};
  var deck = document.getElementById('orb-deck');
  var dw = deck && deck.contentWindow;

  // Wait for the embedded deck to expose its probe surface.
  var tries = 0;
  while (tries++ < 50 && !(dw && dw.__deckProbe)) { await sleep(100); dw = deck && deck.contentWindow; }
  out.probeFnPresent = !!(dw && dw.__deckProbe);
  if (!out.probeFnPresent) return JSON.stringify({ pass:false, detail: out });

  // 1) Wake-capture flag -> the WHOLE chain shows listening (feed -> pump -> pill + deck).
  _lwCapturing = true;
  await sleep(450);
  var st = dw.__deckProbe();
  out.mode = st.mode; out.liveOn = st.on;
  out.pillText = document.getElementById('pill-state').textContent;
  out.orbText = document.getElementById('orb-state').textContent;
  _lwCapturing = false;
  await sleep(200);

  // 2) Speaking pulse — drive it through the REAL host path. The pump is the single
  //    authority (posts every ~45ms from the feed), so we set the real input the pump
  //    reads for speech and let IT post 'speaking', the same way Piper playback does.
  //    (A competing postMessage would be overwritten by design — that's correct.)
  _lwCapturing = false;
  var _origTtsActive = window.ttsActive;
  window.ttsActive = function(){ return true; };   // pump's sync() reads this -> ttsPlaying:true
  await sleep(300);
  var s1 = dw.__deckProbe();
  await sleep(350);
  var s2 = dw.__deckProbe();
  out.speakMode = s2.mode;
  out.speakEnergy = Math.max(s1.uActivity, s2.uActivity);
  window.ttsActive = _origTtsActive;               // restore before moving on
  await sleep(120);

  // 3) Task choreography: dispatch out (dir +1), then a return pulse home (dir -1).
  dw.postMessage({ type:'caryl-task', op:'dispatch', agent:'VISION', id:'probe·VISION', label:'probe' }, '*');
  await sleep(180);
  var pkts = dw.__deckProbe().pkts;
  out.dispatchPkt = pkts.filter(function(p){ return p.name === 'VISION'; })[0] || null;
  await sleep(1100);  // pktDur 0.9s — let it land
  dw.postMessage({ type:'caryl-task', op:'return', agent:'VISION', id:'probe·VISION', ok:true }, '*');
  await sleep(180);
  pkts = dw.__deckProbe().pkts;
  out.returnPkt = pkts.filter(function(p){ return p.name === 'VISION'; })[0] || null;

  var pass = out.liveOn === true && out.mode === 'listening'
    && out.pillText === 'listening' && out.orbText === 'listening'
    && out.speakMode === 'speaking' && out.speakEnergy > 0.7
    && !!out.dispatchPkt && out.dispatchPkt.dir === 1
    && !!out.returnPkt && out.returnPkt.dir === -1;
  return JSON.stringify({ pass: pass, detail: out });
})()
