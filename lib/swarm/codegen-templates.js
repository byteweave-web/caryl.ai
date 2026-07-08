// lib/swarm/codegen-templates.js
// ------------------------------------------------------------------
// Coder template library — pure functions, no fs, no model calls.
//
// Each template has:
//   - id         : canonical name (logged in `template_used`)
//   - targets    : array of ALLOWED_TARGETS this template supports
//   - match(ctx) : boolean — true if the spec fits this template
//   - build(ctx) : { proposed_patch, diff_text, notes } — string content
//                  the diff modal renders. Returns STRINGS only; never
//                  writes to disk; never sees confirmed:true.
//
// `ctx` shape: { target, file, original_text, spec }.
//   - target        : 'main'|'renderer'|'preload'|'sidecar'|'styles'
//   - file          : relative path string (relative to the target root)
//   - original_text : the current file contents ('' if absent)
//   - spec          : free-form string from the Orchestrator
//
// Templates accept TWO spec flavors:
//   A. Free-form prose   ("Add a Weather button at top-right that calls
//                         bridge.openWeatherBoard()")
//   B. Explicit key=val  ("label=Weather position=top-right
//                         binding=bridge.openWeatherBoard()")
//
// Prose is the common path; both flavors work via _extract().
// ------------------------------------------------------------------

'use strict';

// Project-static channel whitelist for `add_ipc_handler`. Adding a NEW
// main.js channel requires an Electron app restart to bind the
// ipcMain.handle, so dynamic-channel-allowing would silently fail.
const ALLOWED_MAIN_CHANNELS = Object.freeze([
  'camera:frame', 'camera:capture', 'camera:close',
  'memory:list', 'memory:clear', 'memory:newChat', 'memory:switchChat',
  'ui:status', 'ui:activity', 'ui:sendText',
  'config:get', 'config:set',
  'doc:import', 'doc:importPath',
  'voice:list', 'voice:install', 'voice:download', 'voice:use',
  'orchestrator:dispatch', 'orchestrator:dispatchChain',
  'coder:apply', 'coder:preview',
]);

// _extract: try each pattern; return first capture (or null).
function _extract(spec, patterns) {
  if (!spec) return null;
  for (const p of patterns) {
    const m = String(spec).match(p);
    if (m && m[1] != null) return String(m[1]).trim();
  }
  return null;
}

// Convenience: extract a "key=value" or "key: value" pair from explicit
// specs. Falls back to null. Case-insensitive.
function _pair(spec, key) {
  const re = new RegExp('(?:^|[;\\s,])(?:' + key + ')\\s*[=:]\\s*["\\\']?([^"\\\'\\n;,]+)["\\\']?', 'i');
  return _extract(spec, [re]);
}

// Render a unified-diff between before and after.
function _diff(filePath, before, after) {
  const NL = '\n';
  const a = String(before == null ? '' : before).split(/\r?\n/);
  const b = String(after == null ? '' : after).split(/\r?\n/);
  const max = Math.max(a.length, b.length);
  const hunks = [];
  let start = null, buf = [];
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) { if (buf.length) { hunks.push(`@@ -${start + 1} +${start + 1} @@`); buf.forEach(function (l) { hunks.push(l); }); buf = []; start = null; } continue; }
    if (start == null) start = i;
    if (a[i] != null) buf.push('-' + a[i]);
    if (b[i] != null) buf.push('+' + b[i]);
  }
  if (buf.length) { hunks.push(`@@ -${start + 1} +${start + 1} @@`); buf.forEach(function (l) { hunks.push(l); }); }
  return `--- a/${filePath}${NL}+++ b/${filePath}${NL}${hunks.join(NL)}${NL}`;
}

// --- Template: bind_button (renderer only) -------------------------
// Prose: "Add a 'Weather' button at top-right that calls bridge.openWeatherBoard()"
// Explicit: label=Weather position=top-right binding=bridge.openWeatherBoard()
const bind_button = {
  id: 'bind_button',
  targets: ['renderer'],
  match: function (ctx) {
    if (ctx.target !== 'renderer') return false;
    const s = String(ctx.spec || '').toLowerCase();
    return /\bbutton\b|\bicon-?button\b/.test(s);
  },
  build: function (ctx) {
    const label = _extract(ctx.spec, [
      new RegExp('label\\s*[=:]\\s*["\\\']?([^"\\\'\\n;,]+)', 'i'),
      /["']([A-Z][\w ]{1,30})["']\s*(?:button|icon-?button)/i,
      /(?:add|insert|create)\s+(?:an?\s+)?["']?([A-Z][\w ]{1,30})["']?\s+(?:button|icon)/i,
      /(?:add|insert|create)\s+(?:an?\s+)?([\w-]{2,30})\s+(?:button|icon)/i,
    ]) || 'Action';
    const action = _extract(ctx.spec, [
      new RegExp('binding\\s*[=:]\\s*["\\\']?([^"\\\'\\n;,()]+)', 'i'),
      new RegExp('(?:onclick|calls?)\\s*[=:]\\s*["\\\']?([^"\\\'\\n;,()]+)', 'i'),
      /calls?\s+([\w.]+)\s*\(/i,
      /[Oo]n\s*click\s*=\s*["\']?([\w.]+)/i,
    ]) || ('bridge.do(\'' + String(label).toLowerCase().replace(/\s+/g, '_') + '\')');
    const position = _extract(ctx.spec, [
      new RegExp('position\\s*[=:]\\s*["\\\']?([a-z-]+)', 'i'),
      /\bat\s+(top-right|top-left|bottom-right|bottom-left|center)/i,
    ]) || 'top-right';
    const posStyle = position === 'top-left' ? 'left:14px;top:14px;'
      : position === 'bottom-right' ? 'right:14px;bottom:14px;'
      : position === 'bottom-left' ? 'left:14px;bottom:14px;'
      : position === 'center' ? 'left:50%;top:50%;transform:translate(-50%,-50%);'
      : 'right:14px;top:14px;';
    const idSlug = String(label).toLowerCase().replace(/[^a-z0-9]/g, '-') || 'action';
    const snippet = [
      `<button id="coder-btn-${idSlug}" class="coder-btn" onclick="${action}">${label}</button>`,
      `<style>`,
      `.coder-btn { position: fixed; ${posStyle} z-index: 9; padding: 8px 14px;`,
      `  background: rgba(127,209,255,0.16); color: #e7e9ee; border: 1px solid rgba(127,209,255,0.4);`,
      `  border-radius: 999px; font-family: ui-sans-serif, system-ui, sans-serif; cursor: pointer;`,
      `  backdrop-filter: blur(8px); transition: transform 120ms, background 120ms; }`,
      `.coder-btn:hover { background: rgba(127,209,255,0.28); transform: translateY(-1px); }`,
      `</style>`,
    ].join('\n');
    const before = ctx.original_text || '';
    const after = before + (before && !before.endsWith('\n') ? '\n' : '') + snippet + '\n';
    return {
      proposed_patch: snippet,
      diff_text: _diff(ctx.file, before, after),
      notes: 'Appended a single floating ' + label + ' button at ' + position + ' to ' + ctx.file + '.',
    };
  },
};

// --- Template: add_preload_bridge (preload only) ------------------
// Prose: "Expose bridge.dismissOverlay() that invokes overlay:hide"
// Explicit: name=dismissOverlay channel=overlay:hide
const add_preload_bridge = {
  id: 'add_preload_bridge',
  targets: ['preload'],
  match: function (ctx) {
    if (ctx.target !== 'preload') return false;
    const s = String(ctx.spec || '').toLowerCase();
    return /\bbridge\b|\bexpose\b|\bpreload\b|\bcontextbridge\b|\bipcrenderer\.invoke\b|\bnew\s+bridge\s+method\b/.test(s);
  },
  build: function (ctx) {
    const name = _extract(ctx.spec, [
      new RegExp('name\\s*[=:]\\s*["\\\']?([\\w.]+)', 'i'),
      /bridge\.([a-zA-Z]\w*)\s*\(/,
      /expose\s+bridge\.?([a-zA-Z]\w*)/i,
      /(?:method|bridge)\s+([a-zA-Z]\w*)/i,
    ]);
    const channel = _extract(ctx.spec, [
      new RegExp('channel\\s*[=:]\\s*["\\\']?([\w:.-]+)', 'i'),
      /invokes?\s+["\']([\w:.-]+)["\']/i,
      /calls?\s+["\']([\w:.-]+)["\']/i,
      /invokes?\s+([\w:.-]+)/i,                  // unquoted prose
      /calls?\s+([\w:.-]+)/i,                    // unquoted prose
      /ipcrenderer\.invoke\s*\(\s*["\']([\w:.-]+)["\']/i,
    ]) || 'rename:me:channel';
    if (!name) return { proposed_patch: '', diff_text: '', notes: 'add_preload_bridge refused: spec did not name a bridge method. Include "bridge.NAME()", "name=NAME", or "expose bridge.NAME". Got: ' + String(ctx.spec).slice(0, 240) };
    const safeName = String(name).replace(/[^a-zA-Z0-9]/g, '');
    if (!safeName) return { proposed_patch: '', diff_text: '', notes: 'add_preload_bridge refused: name "' + name + '" is not a valid JavaScript identifier.' };
    const before = ctx.original_text || '';
    const invocation = `  ${safeName}: (...args) => ipcRenderer.invoke('${channel}', ...args),`;
    const exposeEntry = `    ${safeName},`;
    let after = before;
    const re = /contextBridge\.exposeInMainWorld\([^,]+,\s*\{/;
    if (re.test(after)) {
      after = after.replace(re, function (m) { return m + '\n' + exposeEntry; });
      const closeMatch = after.lastIndexOf('});');
      if (closeMatch !== -1) {
        const tail = `\n// [coder-generated] ${safeName} bridge helper\n${safeName}: ${invocation}\n`;
        after = after.slice(0, closeMatch + 3) + tail + after.slice(closeMatch + 3);
      }
    } else {
      after = after + (after && !after.endsWith('\n') ? '\n' : '') + invocation + '\n' + exposeEntry + '\n';
    }
    return {
      proposed_patch: after,
      diff_text: _diff(ctx.file, before, after),
      notes: 'Preload patched with ' + safeName + '() bridging channel "' + channel + '". ACTION REQUIRED for runtime correctness: dispatch a SECOND coder.generate with target="main" to add the matching ipcMain.handle so the channel resolves — until then, this bridge call returns {}.',
    };
  },
};

// --- Template: add_ipc_handler (main only) -------------------------
// Prose: "Add an ipcMain.handle for 'camera:frame' that returns {ok:true}"
// Explicit: channel=camera:frame return={ok:true}
const add_ipc_handler = {
  id: 'add_ipc_handler',
  targets: ['main'],
  match: function (ctx) {
    if (ctx.target !== 'main') return false;
    const s = String(ctx.spec || '').toLowerCase();
    return /\bipcmain\.handle\b|\bipc\s+handler\b|\bnew\s+ipc\b|\badd\s+an?\s+ipc\b|\bhook\b/.test(s);
  },
  build: function (ctx) {
    const channel = _extract(ctx.spec, [
      new RegExp('channel\\s*[=:]\\s*["\\\']?([\w:.-]+)', 'i'),
      new RegExp('name\\s*[=:]\\s*["\\\']?([\w:.-]+)', 'i'),
      /ipcMain\.handle\s*\(\s*["\']([\w:.-]+)["\']/i,
      /for\s+["\']([\w:.-]+)["']/i,
    ]);
    if (!ALLOWED_MAIN_CHANNELS.includes(channel)) {
      return {
        proposed_patch: '',
        diff_text: '',
        notes: 'add_ipc_handler refused: channel "' + channel + '" is not on the project-static allow-list. Allowed: ' + ALLOWED_MAIN_CHANNELS.join(', '),
        refused: true,
      };
    }
    const handlerBody = _extract(ctx.spec, [
      new RegExp('(?:return|body|return_shape)\\s*[=:]\\s*(.+?)(?:\\.\\s*$|$)', 'i'),
      /returns?\s+(\{[^}]+\})/,
    ]) || '// (handler body — fill in)\n  return { ok: true };';
    const before = ctx.original_text || '';
    const block = [
      `\n// [coder-generated] ${channel} IPC`,
      `ipcMain.handle('${channel}', async (_e, ...args) => {`,
      '  try {',
      `    ${String(handlerBody).replace(/\n/g, '\n    ')}`,
      '  } catch (e) {',
      "    return { ok: false, error: '" + channel + "_threw: ' + (e && e.message ? e.message : String(e)) };",
      '  }',
      '});',
      '',
    ].join('\n');
    const closeIdx = before.lastIndexOf('});');
    const after = closeIdx !== -1
      ? before.slice(0, closeIdx + 3) + '\n' + block + before.slice(closeIdx + 3)
      : before + (before && !before.endsWith('\n') ? '\n' : '') + block;
    return {
      proposed_patch: block,
      diff_text: _diff(ctx.file, before, after),
      notes: 'Inserted ipcMain.handle(' + channel + ', ...) with try/catch envelope.',
    };
  },
};

// --- Template: add_css_rule (styles only) -------------------------
// Prose: "Append a CSS rule .x-badge { color: gold; }"
// Explicit: selector=.x-badge declarations=color: gold;
const add_css_rule = {
  id: 'add_css_rule',
  targets: ['styles'],
  match: function (ctx) {
    if (ctx.target !== 'styles') return false;
    const s = String(ctx.spec || '').toLowerCase();
    return /\bcss\b|@media|@keyframes|selector|\.[a-z][\w-]*\s*\{|#[a-z][\w-]*\s*\{/.test(s);
  },
  build: function (ctx) {
    const selector = _extract(ctx.spec, [
      new RegExp('selector\\s*[=:]\\s*["\\\']?([.#][\w-]+)', 'i'),
      /(?:append|add)\s+(?:a\s+)?(?:css\s+rule\s+)?([.#][\w-]+)/i,
      /([.#][\w-]+)\s*\{/,
    ]) || '.coder-rule';
    const declarations = _extract(ctx.spec, [
      new RegExp('(?:declarations|style|rule)\\s*[=:]\\s*([^;]+?)(?:\\.\\s*$|$)', 'i'),
      /\{\s*([^}]+)\s*\}/,
    ]) || '/* TODO: fill in */';
    const before = ctx.original_text || '';
    const block = `\n/* [coder-generated] ${selector} */\n${selector} { ${declarations} }\n`;
    const after = before + (before && !before.endsWith('\n') ? '\n' : '') + block;
    return {
      proposed_patch: block,
      diff_text: _diff(ctx.file, before, after),
      notes: 'Appended CSS rule `' + selector + '` to bottom of file (cascade-safe).',
    };
  },
};

// --- Template: find_replace (any target) --------------------------
// Prose: "Find replace alpha with beta" / "Replace alpha with beta"
// Explicit: search=alpha replace=beta
const find_replace = {
  id: 'find_replace',
  targets: ['main', 'renderer', 'preload', 'sidecar', 'styles'],
  match: function (ctx) {
    if (!ctx.spec) return false;
    return /\bfind\b|\breplace\b|\brename\b/i.test(ctx.spec);
  },
  build: function (ctx) {
    const search = _pair(ctx.spec, 'search') || _pair(ctx.spec, 'find');
    const replace = _pair(ctx.spec, 'replace') || _pair(ctx.spec, 'substitute');
    if (typeof search !== 'string' || typeof replace !== 'string') {
      return { proposed_patch: '', diff_text: '', notes: 'find_replace refused: spec must carry both search= and replace= fields. Got: ' + JSON.stringify(ctx.spec).slice(0, 240) };
    }
    const before = ctx.original_text || '';
    let count = 0, idx = 0;
    while ((idx = before.indexOf(search, idx)) !== -1) { count += 1; idx += search.length; }
    if (count === 0) {
      return { proposed_patch: '', diff_text: '', notes: 'find_replace refused: search string not found in ' + ctx.file + '. Critic should reformulate spec with more context.', error_kind: 'search_not_found' };
    }
    if (count > 1) {
      return { proposed_patch: '', diff_text: '', notes: 'find_replace refused: search string matches ' + count + ' lines in ' + ctx.file + '; provide more unique context.', error_kind: 'search_not_unique' };
    }
    const after = before.replace(search, replace);
    return {
      proposed_patch: replace,
      diff_text: _diff(ctx.file, before, after),
      notes: 'Replaced exactly one occurrence of the search string in ' + ctx.file + '.',
    };
  },
};

// --- Template: append_section (any target) ------------------------
// Explicit: marker=... content=...
const append_section = {
  id: 'append_section',
  targets: ['main', 'renderer', 'preload', 'sidecar', 'styles'],
  match: function (ctx) {
    return !!(_pair(ctx.spec, 'marker') && _pair(ctx.spec, 'content'));
  },
  build: function (ctx) {
    // Stop marker extraction BEFORE the `content=` boundary so a spec
    // like "marker=----- B ----- content=bar();" doesn't greedily eat
    // both halves as the marker.
    const markerRaw = _extract(ctx.spec, [
      new RegExp('marker\\s*[=:]\\s*["\\\']?(.+?)(?=\\s*content\\s*[=:]|$)', 'i'),
    ]);
    const marker = (markerRaw || '').trim().replace(/^["']|["']$/g, '');
    const content = ((_extract(ctx.spec, [
      // Capture the ENTIRE content value, including trailing semicolons —
      // the spec author wrote `content=bar();` and expects that line
      // verbatim. Trim trailing whitespace only.
      new RegExp('content\\s*[=:]\\s*["\\\']?(.+?)\\s*$', 'i'),
    ]) || '').replace(/^["']|["']$/g, '')).replace(/\s+$/, '');
    const before = ctx.original_text || '';
    if (!marker || !content) {
      return { proposed_patch: '', diff_text: '', notes: 'append_section refused: marker and content must both be present. Got marker=' + JSON.stringify(marker) + ', content=' + JSON.stringify(content) };
    }
    const lines = before.split('\n');
    const insertAt = lines.findIndex(function (l) { return l.indexOf(marker) !== -1; });
    if (insertAt === -1) {
      return { proposed_patch: '', diff_text: '', notes: 'append_section refused: marker "' + marker + '" not found in ' + ctx.file };
    }
    const after = lines.slice(0, insertAt + 1).concat([content]).concat(lines.slice(insertAt + 1)).join('\n');
    return {
      proposed_patch: content,
      diff_text: _diff(ctx.file, before, after),
      notes: 'Inserted content right after line containing "' + marker + '" in ' + ctx.file + '.',
    };
  },
};

// --- noop fallback -------------------------------------------------
function noop(ctx) {
  return {
    proposed_patch: '',
    diff_text: '',
    notes: [
      'NO TEMPLATE MATCHED for spec: "' + String(ctx.spec).slice(0, 240) + '"',
      'template_used: none',
      'recommended_next_step: re-dispatch with explicit data.search + data.replace fields, OR with one of the supported template-trigger phrases:',
      '  "Add a Weather button at top-right that calls bridge.openWeatherBoard()" - bind_button',
      '  "Expose bridge.dismissOverlay() that invokes overlay:hide" - add_preload_bridge',
      '  "Add an ipcMain.handle for \'camera:frame\' that returns..." - add_ipc_handler (channel must be on the project whitelist)',
      '  "Append a CSS rule .x-badge { ... }" - add_css_rule',
      '  "Find replace alpha with beta" - find_replace (search MUST be unique)',
      '  "marker=... content=..." - append_section',
    ].join('\n'),
    template_used: 'noop',
  };
}

// ---- Public registry: priority order, first-match-wins -----------
const TEMPLATES = [
  bind_button,         // renderer
  add_preload_bridge,  // preload
  add_ipc_handler,     // main
  add_css_rule,        // styles
  append_section,      // any (explicit marker+content only)
  find_replace,        // any
];

function pick(ctx) {
  for (const t of TEMPLATES) {
    if (!t.targets.includes(ctx.target)) continue;
    if (t.match(ctx)) return Object.assign(t.build(ctx), { template_used: t.id });
  }
  return noop(ctx);
}

module.exports = {
  TEMPLATES,
  pick,
  ALLOWED_MAIN_CHANNELS,
  _extract: _extract,
  _diff: _diff,
};
