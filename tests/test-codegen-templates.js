// tests/test-codegen-templates.js
// ------------------------------------------------------------------
// Pure-function tests for lib/swarm/codegen-templates.js.
// No fs, no model calls, no IPC — every assertion is deterministic
// against in-memory strings.
// ------------------------------------------------------------------

'use strict';

const path = require('path');
const tpl = require('../lib/swarm/codegen-templates');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) pass++; else { fail++; console.error('  FAIL:', msg); }
}
function run(name, fn) {
  try { fn(); console.log('  pass:', name); }
  catch (e) { fail++; console.error('  exc:', name, e && e.message); }
}
console.log('--- codegen-templates tests ---');

// 1. bind_button: target=renderer, spec mentions button + binding
run('bind_button emits a button + style block', function () {
  const out = tpl.pick({ target: 'renderer', file: 'index.html', original_text: '<html></html>', spec: 'Add a "Weather" button at top-right that calls bridge.openWeatherBoard().' });
  assert(out.template_used === 'bind_button', 'template_used should be bind_button, got ' + out.template_used);
  assert(/<button/.test(out.proposed_patch), 'proposed_patch should contain <button');
  assert(/\.coder-btn/.test(out.proposed_patch), 'proposed_patch should contain .coder-btn style');
  assert(/openWeatherBoard/.test(out.proposed_patch) || out.notes.indexOf('bridge.openWeatherBoard') !== -1, 'should reference the binding');
  assert(out.diff_text.indexOf('+++') === -1 || out.diff_text.indexOf('---') !== -1, 'diff should have file paths');
});

// 2. bind_button rejected when target isn't renderer
run('bind_button refuses non-renderer targets', function () {
  const out = tpl.pick({ target: 'main', file: 'main.js', original_text: '', spec: 'Add a button that calls foo()' });
  assert(out.template_used !== 'bind_button', 'should not bind_button off-target');
});

// 3. add_preload_bridge: target=preload, mentions contextBridge + name
run('add_preload_bridge produces invoke + expose', function () {
  const before = "const { contextBridge, ipcRenderer } = require('electron');\n\ncontextBridge.exposeInMainWorld('bridge', {\n  // existing entry\n});";
  const out = tpl.pick({ target: 'preload', file: 'preload.js', original_text: before, spec: 'Expose bridge.dismissOverlay() that invokes overlay:hide' });
  assert(out.template_used === 'add_preload_bridge', 'should pick add_preload_bridge, got ' + out.template_used);
  assert(/overlay:hide/.test(out.proposed_patch), 'output should reference overlay:hide channel');
  // Critical: notes must warn Orchestrator to dispatch a follow-up MAIN handler.
  assert(/SECOND coder\.generate with target="main"/.test(out.notes) || /dispatch a SECOND coder\.generate/.test(out.notes), 'notes should ask Orchestrator for the matching main.js patch');
});

// 4. add_ipc_handler ON-WHITELIST: should succeed
run('add_ipc_handler accepts whitelisted channel', function () {
  const out = tpl.pick({ target: 'main', file: 'main.js', original_text: '', spec: "Add an ipcMain.handle for 'camera:frame' that returns {ok:true}" });
  assert(out.template_used === 'add_ipc_handler', 'should pick add_ipc_handler, got ' + out.template_used);
  assert(/ipcMain\.handle\('camera:frame'/.test(out.proposed_patch), 'should emit ipcMain.handle line');
  assert(/camera:frame/.test(out.diff_text), 'diff should mention the channel');
});

// 5. add_ipc_handler OFF-WHITELIST: should be refused
run('add_ipc_handler refuses non-whitelisted channel', function () {
  const out = tpl.pick({ target: 'main', file: 'main.js', original_text: '', spec: "Add an ipcMain.handle for 'foo:bar' channel" });
  assert(out.refused === true, 'should mark refused=true');
  assert(/not on the project-static allow-list/.test(out.notes), 'notes should mention allow-list');
});

// 6. add_css_rule: appends to bottom
run('add_css_rule appends to bottom', function () {
  const before = '.foo { color: red; }\n';
  const out = tpl.pick({ target: 'styles', file: 'theme.css', original_text: before, spec: 'Append a CSS rule .x-badge { color: gold; }' });
  assert(out.template_used === 'add_css_rule', 'should pick add_css_rule, got ' + out.template_used);
  assert(/\.x-badge/.test(out.proposed_patch), 'should reference the selector');
  assert(out.diff_text.indexOf(before) === -1 || out.proposed_patch.indexOf(before) === -1, 'output should not be the bare original');
});

// 7. find_replace: strict uniqueness → success
run('find_replace succeeds on unique match', function () {
  const before = 'function alpha() { return 1; }\nfunction beta() { return 2; }\n';
  const out = tpl.pick({ target: 'main', file: 'main.js', original_text: before, spec: 'search=alpha() { return 1; } replace=alpha() { return 99; }' });
  assert(out.template_used === 'find_replace', 'should pick find_replace, got ' + out.template_used);
  assert(/replaced exactly one occurrence/i.test(out.notes), 'notes should record single replacement');
});

// 8. find_replace: missing search → refused
run('find_replace refuses when search string missing', function () {
  const out = tpl.pick({ target: 'main', file: 'main.js', original_text: 'hello world', spec: 'search=doesnotexist replace=something' });
  assert(/refused/i.test(out.notes) || /not found/i.test(out.notes), 'notes should mention refusal');
});

// 9. find_replace: ambiguous search → refused
run('find_replace refuses when search string appears >1 times', function () {
  const before = 'foo(); foo(); foo();';
  const out = tpl.pick({ target: 'main', file: 'main.js', original_text: before, spec: 'search=foo() replace=bar()' });
  assert(/refused/i.test(out.notes) || /not unique/i.test(out.notes) || /matches [2-9] lines/i.test(out.notes), 'notes should mention ambiguity, got: ' + out.notes);
});

// 10. append_section: inserts after marker
run('append_section inserts after marker line', function () {
  const before = '// ----- A -----\nfoo();\n// ----- B -----\n';
  const out = tpl.pick({ target: 'main', file: 'main.js', original_text: before, spec: 'marker=----- B ----- content=bar();' });
  assert(out.template_used === 'append_section', 'should pick append_section, got ' + out.template_used);
  assert(/\+ ?bar\(\);/.test(out.diff_text), 'diff should add bar(); line');
});

// 11. noop: returns notes-only payload when nothing matches
run('noop fallback returns recommended_next_step note', function () {
  const out = tpl.pick({ target: 'main', file: 'main.js', original_text: '', spec: 'make the doorbell ring twice louder when the moon is up on tuesdays' });
  assert(out.template_used === 'noop', 'should be noop, got ' + out.template_used);
  assert(/recommended_next_step/.test(out.notes), 'notes should include recommended_next_step');
  assert(/bind_button|add_preload_bridge|add_ipc_handler|find_replace|append_section/.test(out.notes), 'notes should list template-trigger phrases');
});

// 12. priority: bind_button beats append_section if both could match
run('priority: bind_button wins over append_section for renderer button spec', function () {
  const out = tpl.pick({ target: 'renderer', file: 'index.html', original_text: '', spec: 'Add a marker=foo content=bar button that calls bridge.run()' });
  assert(out.template_used === 'bind_button', 'bind_button should win on priority, got ' + out.template_used);
});

// 13. _diff helper produces valid unified-diff shape
run('_diff helper produces unified-diff with file paths', function () {
  const d = tpl._diff('foo.js', 'a\nb\nc\n', 'a\nB\nc\n');
  assert(d.indexOf('--- a/foo.js') === 0, 'diff should start with --- a/foo.js');
  assert(d.indexOf('+++ b/foo.js') > 0, 'diff should mention +++ b/foo.js');
  assert(/-b$/.test(d.split('\n').slice(-3).join('\n')) || /-b/.test(d), 'diff should mark removed line');
  assert(/\+B/.test(d), 'diff should mark added line');
});

// 14. ALLOWED_MAIN_CHANNELS listed contains expected canonical channels
run('ALLOWED_MAIN_CHANNELS contains the basic canonical channels', function () {
  assert(tpl.ALLOWED_MAIN_CHANNELS.indexOf('camera:frame') !== -1, 'camera:frame missing');
  assert(tpl.ALLOWED_MAIN_CHANNELS.indexOf('orchestrator:dispatch') !== -1, 'orchestrator:dispatch missing');
  assert(tpl.ALLOWED_MAIN_CHANNELS.indexOf('config:get') !== -1, 'config:get missing');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
