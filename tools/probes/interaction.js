(function () {
  var out = {};
  var cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  var engine = document.getElementById('engine');

  // Orb focused: the live deck must receive clicks (drag-orbit/hover/click-focus).
  window.Shell.setFocus('orb');
  var h1 = document.elementFromPoint(cx, cy);
  out.orbHit = h1 && (h1.id || h1.className);
  out.orbHitIsDeck = !!(h1 && (h1.id === 'orb-deck' || (h1.closest && h1.closest('.engine'))));
  out.enginePE_orb = getComputedStyle(engine).pointerEvents;

  // Top chrome must still work.
  var tab = document.querySelector('.tab[data-view="chat"]'); var tr = tab.getBoundingClientRect();
  var th = document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2);
  out.tabOk = !!(th && th.classList && th.classList.contains('tab'));

  // Chat focused: engine is inert; the glass + composer capture instead.
  window.Shell.setFocus('chat');
  var h2 = document.elementFromPoint(cx, cy);
  out.chatHit = h2 && (h2.id || h2.className || h2.tagName);
  out.chatHitNotEngine = !(h2 && h2.id === 'orb-deck');
  out.enginePE_chat = getComputedStyle(engine).pointerEvents;
  var send = document.querySelector('.composer .send'); var sr = send.getBoundingClientRect();
  var sh = document.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2);
  out.sendOk = !!(send && (sh === send || send.contains(sh)));

  var pass = out.orbHitIsDeck && out.enginePE_orb === 'auto' && out.tabOk &&
             out.chatHitNotEngine && out.enginePE_chat === 'none' && out.sendOk;
  return JSON.stringify({ pass: pass, detail: out });
})()
