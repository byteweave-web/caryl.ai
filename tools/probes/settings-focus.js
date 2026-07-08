(async function () {
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
  var root = document.documentElement, out = {};
  if(!window.Shell){ return JSON.stringify({ pass:false, detail:{ error:'Shell missing' } }); }

  // The dark modal scrim must be gone — the pulled-back engine is the backdrop now.
  out.scrimGone = !document.getElementById('scrim');

  // Enter Settings as a focus-layer.
  Shell.setFocus('orb'); await sleep(120);
  Shell.setFocus('settings');
  await sleep(650);   // let the 420ms spine ease --focus-depth / --glass-density
  var cs = getComputedStyle(root);
  out.dataFocus    = root.getAttribute('data-focus');
  out.focusDepth   = parseFloat(cs.getPropertyValue('--focus-depth'));
  out.glassDensity = parseFloat(cs.getPropertyValue('--glass-density'));
  var panel = document.getElementById('settings'), pcs = getComputedStyle(panel);
  out.panelOpacity = parseFloat(pcs.opacity);
  out.panelPE      = pcs.pointerEvents;
  // Regression (Phase 3): the Chat layer must NOT leak in behind the Settings glass — its
  // visibility must key off being the active focus, not the shared --focus-depth (1 here too).
  out.chatOpacityInSettings = parseFloat(getComputedStyle(document.getElementById('view-chat')).opacity);
  // Engine keeps rendering behind the glass (0.72 < 0.92 occlusion).
  out.engineThrottled = !!(window.ShellReducer && window.ShellReducer.deriveShell({focus:'settings'}).engineThrottle);
  // The topbar gear stays hittable while Settings is up.
  var gear = document.querySelector('.topbar .iconbtn'); var gr = gear.getBoundingClientRect();
  var gh = document.elementFromPoint(gr.left+gr.width/2, gr.top+gr.height/2);
  out.gearHittable = !!(gh && (gh===gear || gear.contains(gh)));

  // Exit restores the prior focus (orb) and hides the panel.
  Shell.setFocus('orb'); await sleep(650);
  out.exitDataFocus   = root.getAttribute('data-focus');
  out.exitPanelOpacity = parseFloat(getComputedStyle(panel).opacity);

  var pass = out.scrimGone && out.dataFocus==='settings'
    && out.focusDepth > 0.8 && Math.abs(out.glassDensity - 0.72) < 0.12
    && out.panelOpacity > 0.9 && out.panelPE === 'auto'
    && out.chatOpacityInSettings < 0.1
    && out.engineThrottled === false && out.gearHittable === true
    && out.exitDataFocus === 'orb' && out.exitPanelOpacity < 0.1;
  return JSON.stringify({ pass: pass, detail: out });
})()
