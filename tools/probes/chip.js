(async function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  await sleep(300);
  var out = {};
  out.api = !!(window.Shell && typeof window.Shell.chip === 'function');
  if (!out.api) return JSON.stringify({ pass: false, detail: out });

  var ran = { scan: 0 };
  window.Shell.chip('I see a bill — scan & log it?', {
    ms: 5000,
    actions: [{ label: 'Scan', fn: function () { ran.scan++; } }, { label: 'Dismiss' }],
  });
  await sleep(120);
  var c = document.querySelector('.shell-chip');
  out.exists = !!c;
  out.inTR = !!(c && c.parentElement && c.parentElement.id === 'slot-TR');
  out.text = c ? c.textContent : '';
  var btns = c ? c.querySelectorAll('.chip-btn') : [];
  out.buttons = btns.length;
  out.primaryFirst = !!(btns[0] && btns[0].classList.contains('primary') && /scan/i.test(btns[0].textContent));

  if (btns[0]) btns[0].click();
  await sleep(60);
  out.actionRan = ran.scan === 1;
  out.releasedAfterClick = !(c && c.parentElement && c.parentElement.classList &&
                             c.parentElement.classList.contains('slotzone'));

  // a new chip replaces the old and auto-expires
  window.Shell.chip('short chip', { ms: 1500, actions: [{ label: 'Ok' }] });
  await sleep(120);
  var c2 = document.querySelector('.shell-chip');
  out.reshown = !!(c2 && c2.parentElement && c2.parentElement.id === 'slot-TR' && /short chip/.test(c2.textContent));
  await sleep(1800);
  out.expired = !(c2 && c2.parentElement && c2.parentElement.classList &&
                  c2.parentElement.classList.contains('slotzone'));

  var pass = out.exists && out.inTR && /scan & log/i.test(out.text) && out.buttons === 2 &&
             out.primaryFirst && out.actionRan && out.releasedAfterClick && out.reshown && out.expired;
  return JSON.stringify({ pass: pass, detail: out });
})()
