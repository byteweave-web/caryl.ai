(async function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  await sleep(300);
  var out = {};
  out.api = !!(window.Shell && typeof window.Shell.toast === 'function');
  if (!out.api) return JSON.stringify({ pass: false, detail: out });

  // A toast claims TR, shows, and auto-releases after its ms.
  window.Shell.toast('probe toast', { ms: 700 });
  await sleep(120);
  var t = document.querySelector('.shell-toast');
  out.exists = !!t;
  out.inTR = !!(t && t.parentElement && t.parentElement.id === 'slot-TR');
  out.text = t && t.textContent;
  out.shown = !!(t && t.classList.contains('show'));
  out.glass = !!(t && t.classList.contains('glass'));

  await sleep(1100);
  out.releasedFromZone = !(t && t.parentElement && t.parentElement.classList &&
                           t.parentElement.classList.contains('slotzone'));

  // setHint with lockMs at Orb focus routes through the toast (the composer is invisible there).
  window.Shell.setFocus('orb');
  if (typeof setHint === 'function') {
    setHint('probe hint', 2000);
    await sleep(120);
    var t2 = document.querySelector('.shell-toast');
    out.hintToast = !!(t2 && /probe hint/.test(t2.textContent) &&
                       t2.parentElement && t2.parentElement.id === 'slot-TR');
  } else { out.hintToast = 'no setHint'; }

  var pass = out.exists && out.inTR && /probe toast/.test(out.text || '') && out.shown && out.glass &&
             out.releasedFromZone && out.hintToast === true;
  return JSON.stringify({ pass: pass, detail: out });
})()
