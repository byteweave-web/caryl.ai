(function () {
  // The shell is a desktop app: chrome text (the "idle" status word the user was
  // accidentally highlighting) must not be text-selectable, while readable content
  // (chat transcript) and editable fields stay selectable/copyable.
  function us(el) { return el ? getComputedStyle(el).webkitUserSelect || getComputedStyle(el).userSelect : null; }
  var out = {};
  out.bodyUS      = us(document.body);                               // expect none
  out.orbStateUS  = us(document.getElementById('orb-state'));        // the "idle" word — expect none
  out.pillStateUS = us(document.getElementById('pill-state'));       // topbar "idle" — expect none
  out.inputUS     = us(document.getElementById('chat-input'));       // editable — expect text/auto
  out.orbStateTxt = (document.getElementById('orb-state') || {}).textContent;

  // Prove a drag over the Orb marginalia yields no selection: force a Range over the
  // "idle" node, then let user-select:none collapse it the way a pointer drag would.
  var sel = window.getSelection();
  try {
    sel.removeAllRanges();
    var r = document.createRange();
    r.selectNodeContents(document.getElementById('orb-state'));
    sel.addRange(r);
  } catch (_e) {}
  out.selectedText = String(sel.toString());

  var selectable = function (v) { return v === 'text' || v === 'auto' || v == null; };
  var pass = out.bodyUS === 'none' && out.orbStateUS === 'none' && out.pillStateUS === 'none' &&
             selectable(out.inputUS);
  return JSON.stringify({ pass: pass, detail: out });
})()
