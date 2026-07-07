(function () {
  var out = {};
  if (!window.Shell || typeof renderActs !== 'function') return JSON.stringify({ pass: false, detail: { noShellOrRender: true } });
  window.Shell.setFocus('chat');
  renderActs([
    { kind: 'heard', text: 'what time is it', time: '10:00' },
    { kind: 'said', text: 'It is ten past.', time: '10:01' },
    { kind: 'action', text: 'noted', time: '10:02' },
  ]);
  var box = document.getElementById('chat-scroll');
  var user = box.querySelector('.msg.user');
  var ai = box.querySelector('.msg.ai');
  var t = box.querySelector('.msg .t');
  if (!user || !ai || !t) return JSON.stringify({ pass: false, detail: { missing: { user: !!user, ai: !!ai, t: !!t } } });

  var ug = getComputedStyle(user), ag = getComputedStyle(ai), tg = getComputedStyle(t);
  var uAfter = getComputedStyle(user, '::after'), aBefore = getComputedStyle(ai, '::before');
  var CORE = 'rgb(88, 198, 255)';

  out = {
    userRadius: ug.borderTopLeftRadius, userBg: ug.backgroundColor, userFont: ug.fontFamily,
    userTick: uAfter.backgroundColor, aiLeader: aBefore.backgroundImage,
    tFont: tg.fontFamily, tNums: tg.fontVariantNumeric,
  };

  var pass =
    ug.borderTopLeftRadius === '0px' &&                    // bubbles retired
    (ug.backgroundColor === 'rgba(0, 0, 0, 0)' || ug.backgroundColor === 'transparent') &&
    /Plex Sans/.test(ug.fontFamily) &&                     // prose in --read
    uAfter.backgroundColor === CORE &&                     // your --core tick
    /gradient/.test(aBefore.backgroundImage) && /88, 198, 255/.test(aBefore.backgroundImage) && // Caryl leader tether
    /Plex Mono/.test(tg.fontFamily) &&                     // meta in --mono
    /tabular/.test(tg.fontVariantNumeric);                 // tabular timestamps

  return JSON.stringify({ pass: pass, detail: out });
})()
