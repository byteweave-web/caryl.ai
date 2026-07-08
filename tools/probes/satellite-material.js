(async function () {
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
  await sleep(500);  // let the satellite's async data-os stamp land
  var out = {};
  var cs = getComputedStyle(document.documentElement);
  out.core = cs.getPropertyValue('--core').trim();
  out.coreOk = /^#58c6ff$/i.test(out.core);                      // shared sheet actually loaded
  out.osStamped = !!document.documentElement.dataset.os;         // 'win10' under the stub bridge
  out.themeCssGone = !document.querySelector('link[href="theme.css"]');
  var acc = (cs.getPropertyValue('--accent') || cs.getPropertyValue('--card-accent') || '').trim();
  out.accent = acc;
  out.accentAliased = !!acc && /#58c6ff/i.test(acc);             // alias computed to --core's value
  var isBubble = /mini-overlay\.html$/i.test(location.pathname);
  out.glassEl = !!document.querySelector('.glass');
  out.glassOk = isBubble ? true : out.glassEl;                   // bubble exempt (orb art, no pane)
  var pass = out.coreOk && out.osStamped && out.themeCssGone && out.accentAliased && out.glassOk;
  return JSON.stringify({ pass: pass, detail: out });
})()
