// renderer/coder-diff-modal.js
// ------------------------------------------------------------------
// DiffModal: slides up whenever the Coder sub-agent emits a successful
// dispatch-end. Shows the proposed patch (diff_text + target metadata)
// and gates the disk write on an Apply button click that sets
// confirmed:true server-side.
//
// IMPORTANT: subscribes ONLY to dispatch-end events for the Coder
// agent — by then the template engine has finished and the
// proposed_patch + diff_text are attached to the event payload (see
// lib/swarm/router.js). Earlier dispatches are ignored.
//
// The modal is a single fixed-position <div> injected into <body>. Both the
// wrapper AND the (closed) panel keep pointer-events:none — the panel only
// becomes pointer-events:auto once it has the .open class. opacity:0 alone does
// NOT stop hit-testing, so an "auto" closed panel would sit invisibly over the
// composer and eat every click; gating pointer-events on .open avoids that.
// ------------------------------------------------------------------

(function () {
  if (!window.bridge || typeof window.bridge.onSwarmEvent !== 'function') return;
  if (window.__coderDiffModalInstalled) return;
  window.__coderDiffModalInstalled = true;

  // ---- CSS injection -------------------------------------------------
  const css = document.createElement('style');
  css.id = 'coder-diff-modal-css';
  css.textContent = `
    .cdm-root { position: fixed; left: 0; right: 0; bottom: 20px; display: flex; justify-content: center; z-index: 2147483600; pointer-events: none; }
    .cdm-panel { pointer-events: none; width: min(760px, 92vw); max-height: 60vh; overflow: hidden; display: flex; flex-direction: column;
      background: rgba(14,16,20,0.96); color: #e7e9ee; border: 1px solid rgba(127,209,255,0.32); border-radius: 14px; padding: 14px 16px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04) inset; backdrop-filter: blur(20px); font-family: ui-sans-serif, system-ui, sans-serif;
      transition: transform 220ms cubic-bezier(.2,.8,.2,1), opacity 220ms; opacity: 0; transform: translateY(12px); }
    /* Closed panel stays pointer-events:none — opacity:0 alone still hit-tests and would sit
       invisibly over the composer, swallowing every click. Only the open panel is interactive. */
    .cdm-panel.open { pointer-events: auto; opacity: 1; transform: translateY(0); }
    .cdm-head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
    .cdm-head .cdm-agent { font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: #a98bff; font-weight: 600; }
    .cdm-head .cdm-target { font-size: 11px; color: #8b9099; font-family: ui-monospace, Menlo, monospace; }
    .cdm-head .cdm-file { margin-left: auto; font-size: 11px; color: #5ad6c4; font-family: ui-monospace, Menlo, monospace; max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cdm-template { font-size: 11px; color: #f0b96e; font-family: ui-monospace, Menlo, monospace; margin-bottom: 6px; }
    .cdm-diff { font-family: ui-monospace, Menlo, monospace; font-size: 11px; line-height: 1.45; color: #cfd3da; background: rgba(0,0,0,0.4); padding: 10px 12px; border-radius: 8px; overflow: auto; max-height: 32vh; white-space: pre; }
    .cdm-diff .cdm-add { color: #5ad19a; }
    .cdm-diff .cdm-del { color: #e9637b; }
    .cdm-diff .cdm-hunk { color: #7fd1ff; }
    .cdm-notes { font-size: 12px; color: #8b9099; margin-top: 8px; line-height: 1.4; }
    .cdm-actions { display: flex; gap: 10px; margin-top: 12px; justify-content: flex-end; }
    .cdm-btn { font-family: inherit; font-size: 12px; border-radius: 999px; padding: 8px 14px; cursor: pointer; border: 1px solid rgba(127,209,255,0.32); background: rgba(127,209,255,0.10); color: #e7e9ee; transition: background 120ms; letter-spacing: 0.4px; }
    .cdm-btn:hover { background: rgba(127,209,255,0.22); }
    .cdm-btn-apply { background: rgba(90,209,154,0.16); border-color: rgba(90,209,154,0.45); color: #d5f7e7; }
    .cdm-btn-apply:hover { background: rgba(90,209,154,0.30); }
    .cdm-result { font-size: 11px; font-family: ui-monospace, Menlo, monospace; margin-right: auto; align-self: center; }
    .cdm-result.ok { color: #5ad19a; }
    .cdm-result.err { color: #e9637b; }
  `;
  document.head.appendChild(css);

  // ---- DOM scaffold --------------------------------------------------
  const root = document.createElement('div');
  root.className = 'cdm-root';
  const panel = document.createElement('div');
  panel.className = 'cdm-panel';
  panel.innerHTML = `
    <div class="cdm-head">
      <span class="cdm-agent">Coder</span>
      <span class="cdm-target" data-cdm="target"></span>
      <span class="cdm-file" data-cdm="file"></span>
    </div>
    <div class="cdm-template" data-cdm="template"></div>
    <pre class="cdm-diff" data-cdm="diff"></pre>
    <div class="cdm-notes" data-cdm="notes"></div>
    <div class="cdm-actions">
      <span class="cdm-result" data-cdm="result"></span>
      <button class="cdm-btn cdm-btn-discard" data-cdm="discard">Discard</button>
      <button class="cdm-btn cdm-btn-apply"   data-cdm="apply">Apply</button>
    </div>
  `;
  root.appendChild(panel);
  document.body.appendChild(root);

  const $target = panel.querySelector('[data-cdm="target"]');
  const $file   = panel.querySelector('[data-cdm="file"]');
  const $tpl    = panel.querySelector('[data-cdm="template"]');
  const $diff   = panel.querySelector('[data-cdm="diff"]');
  const $notes  = panel.querySelector('[data-cdm="notes"]');
  const $result = panel.querySelector('[data-cdm="result"]');
  const $apply  = panel.querySelector('[data-cdm="apply"]');
  const $discard = panel.querySelector('[data-cdm="discard"]');

  let current = null; // {target, file, proposed_patch, diff_text, template_used, notes}

  function _highlight(diffText) {
    if (!diffText) return '';
    return String(diffText)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^(\+[^\n]*)$/gm, '<span class="cdm-add">$1</span>')
      .replace(/^(-[^\n]*)$/gm, '<span class="cdm-del">$1</span>')
      .replace(/^(@@[^\n]*@@)$/gm, '<span class="cdm-hunk">$1</span>');
  }

  function show(payload) {
    current = {
      target: payload.target || '(unknown)',
      file:   payload.file   || '(no file)',
      proposed_patch: payload.proposed_patch || '',
      diff_text: payload.diff_text || '',
      template_used: payload.template_used || 'explicit',
      notes: payload.notes || '',
      task_id: payload.task_id || '',
    };
    $target.textContent = current.target;
    $file.textContent = current.file;
    $tpl.textContent = current.template_used ? ('template: ' + current.template_used) : '';
    $diff.innerHTML = _highlight(current.diff_text) || '(no diff)';
    $notes.textContent = current.notes || '';
    $result.textContent = '';
    $result.className = 'cdm-result';
    $apply.disabled = false;
    $apply.textContent = 'Apply';
    $discard.disabled = false;
    requestAnimationFrame(function () { panel.classList.add('open'); });
  }

  function hide() {
    panel.classList.remove('open');
    current = null;
  }

  $apply.addEventListener('click', async function () {
    if (!current) return;
    $apply.disabled = true;
    $apply.textContent = 'Applying…';
    try {
      const r = await window.bridge.coderApply({
        target: current.target,
        file:   current.file,
        new_text: current.proposed_patch,
        confirmed: true,
      });
      if (r && r.ok) {
        $result.textContent = 'applied ' + r.bytes + 'B to ' + (r.file || current.file);
        $result.className = 'cdm-result ok';
        // Auto-hide 2s after success so user gets a beat to read the receipt.
        setTimeout(hide, 2000);
      } else {
        $result.textContent = 'apply refused: ' + (r && r.error ? r.error : 'unknown');
        $result.className = 'cdm-result err';
        $apply.disabled = false;
        $apply.textContent = 'Apply';
      }
    } catch (e) {
      $result.textContent = 'apply threw: ' + (e && e.message ? e.message : String(e));
      $result.className = 'cdm-result err';
      $apply.disabled = false;
      $apply.textContent = 'Apply';
    }
  });

  $discard.addEventListener('click', hide);

  // Esc closes the modal — common keyboard hygiene.
  window.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && panel.classList.contains('open')) hide();
  });

  // ---- Swarm event subscription ------------------------------------
  window.bridge.onSwarmEvent(function (ev) {
    if (!ev || ev.kind !== 'dispatch-end') return;
    if (ev.to !== 'Coder') return;
    if (ev.ok !== true) return;
    if (!ev.proposed_patch && !ev.diff_text) return;
    show({
      target: ev.target || '(unknown)',
      file:   ev.file   || '(no file)',
      proposed_patch: ev.proposed_patch || '',
      diff_text: ev.diff_text || '',
      template_used: ev.template_used || 'unknown',
      notes: ev.notes || '',
      task_id: ev.task_id || '',
    });
    void ev.action;
  });

  // ---- Manual open API for testing ---------------------------------
  // Console-friendly: bridge the existing __swarmPulse pattern.
  window.__coderModalPreview = function (fakeEv) {
    show(Object.assign({
      target: 'renderer', file: 'renderer/index.html',
      proposed_patch: ' <button id="btn-demo">Demo</button>',
      diff_text: '--- a/renderer/index.html\n+++ b/renderer/index.html\n+ <button id="btn-demo">Demo</button>\n',
      template_used: 'manual',
      notes: 'manual preview from console',
    }, fakeEv || {}));
  };
})();
