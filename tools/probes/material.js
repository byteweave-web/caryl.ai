(function () {
  var cs = getComputedStyle(document.documentElement);
  var tok = function (n) { return cs.getPropertyValue(n).trim(); };

  // Scan loaded stylesheets for the declared `.glass` rule. Computed backdrop-filter is
  // unreliable offscreen (SwiftShader reports "none"), so we assert the shipped RULE frosts.
  function glassRuleText() {
    var out = '';
    for (var i = 0; i < document.styleSheets.length; i++) {
      var sheet = document.styleSheets[i], rules;
      try { rules = sheet.cssRules || sheet.rules; } catch (e) { continue; }
      if (!rules) continue;
      for (var j = 0; j < rules.length; j++) {
        var rule = rules[j];
        if (rule.selectorText && /(^|,|\s)\.glass(\s|,|$)/.test(rule.selectorText)) out += ' ' + rule.cssText;
      }
    }
    return out;
  }

  // The offscreen stub bridge returns {} for getShellStyle(), so index.html defaults
  // data-os="win10" — which activates the opaque-gradient fallback. Force the default
  // (non-win10) path so we verify the real frosted material here. (Win10 has its own probe.)
  document.documentElement.setAttribute('data-os', 'win11');

  // A .glass element to read the resolved fill off of.
  var el = document.createElement('div');
  el.className = 'glass';
  document.body.appendChild(el);
  var gs = getComputedStyle(el);

  // Alpha of the computed background — proves the Dynamic Translucency fill actually applies.
  var m = (gs.backgroundColor || '').match(/rgba?\(([^)]+)\)/);
  var parts = m ? m[1].split(',').map(function (s) { return parseFloat(s); }) : [];
  var bgAlpha = parts.length === 4 ? parts[3] : (parts.length === 3 ? 1 : 0);

  var ruleText = glassRuleText();
  var detail = {
    void: tok('--void'), core: tok('--core'), ink: tok('--ink'),
    mono: tok('--mono'), read: tok('--read'), disp: tok('--disp'),
    glassBg: gs.backgroundColor, bgAlpha: bgAlpha,
    glassBorder: gs.borderTopWidth + ' ' + gs.borderTopColor,
    ruleFrosts: /backdrop-filter\s*:\s*blur\(/.test(ruleText),   // declared, not computed
    computedBackdrop: (gs.backdropFilter || gs.webkitBackdropFilter || ''),
    focusDepthInit: tok('--focus-depth'),
    glassDensityInit: tok('--glass-density'),
  };

  var pass =
    tok('--void').toLowerCase() === '#05060b' &&
    tok('--core').toLowerCase() === '#58c6ff' &&
    /IBM Plex Mono/.test(tok('--mono')) &&
    /IBM Plex Sans/.test(tok('--read')) &&
    /Big Shoulders/.test(tok('--disp')) &&
    parseFloat(gs.borderTopWidth) <= 1.5 &&    // hairline, not a chunky border
    bgAlpha > 0.2 &&                            // Dynamic Translucency fill applied
    detail.ruleFrosts &&                        // material ships a backdrop-filter blur
    tok('--focus-depth') === '0' &&             // registered @property, starts at rest
    tok('--glass-density') === '0';

  return JSON.stringify({ pass: pass, detail: detail });
})()
