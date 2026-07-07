(function () {
  // Force the Win10 branch and confirm the glass loses backdrop-filter for the opaque recipe.
  document.documentElement.dataset.os = 'win10';
  var el = document.createElement('div'); el.className = 'glass'; document.body.appendChild(el);
  var gs = getComputedStyle(el);
  var backdrop = (gs.backdropFilter || gs.webkitBackdropFilter || 'none');
  var bg = gs.backgroundImage + ' ' + gs.backgroundColor;

  var detail = { win10Backdrop: backdrop, win10BgImage: gs.backgroundImage, win10BgColor: gs.backgroundColor };
  // Win10: no blur, and a real (gradient or solid) opaque fill.
  var win10ok = !/blur\(/.test(backdrop) && (/gradient/.test(gs.backgroundImage) || /rgb/.test(gs.backgroundColor));

  // reset
  document.documentElement.dataset.os = 'win11';
  var pass = win10ok;
  return JSON.stringify({ pass: pass, detail: detail });
})()
