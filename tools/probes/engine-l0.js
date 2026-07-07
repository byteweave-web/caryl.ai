(function () {
  var deck = document.getElementById('orb-deck');
  var vw = window.innerWidth, vh = window.innerHeight;
  var detail = { hasDeck: !!deck };
  if (!deck) return JSON.stringify({ pass: false, detail: detail });

  var r = deck.getBoundingClientRect();
  var cs = getComputedStyle(deck);
  var wrap = deck.closest('.engine') || deck.parentElement;
  var wcs = getComputedStyle(wrap);

  detail.rect = { w: Math.round(r.width), h: Math.round(r.height) };
  detail.viewport = { w: vw, h: vh };
  detail.wrapClass = wrap.className;
  detail.zIndex = wcs.zIndex || cs.zIndex;
  detail.position = wcs.position;

  // Full-bleed: covers (near) the whole viewport.
  var fullBleed = r.width >= vw - 2 && r.height >= vh - 2;
  // Behind focus layers: engine z resolves below the L2 focus band (20).
  var zNum = parseInt(wcs.zIndex || cs.zIndex || '0', 10) || 0;
  detail.zNum = zNum;
  detail.fullBleed = fullBleed;

  var pass = fullBleed && zNum < 20;
  return JSON.stringify({ pass: pass, detail: detail });
})()
