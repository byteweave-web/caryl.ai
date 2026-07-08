// renderer/chat-import.js
// ===================================================================
//  Chat tab extension: Import button + attachment chips + DOCGEN cards.
//
//  Loaded as a <script src="chat-import.js"> at the end of renderer/index.html.
//  All work is additive - no existing function is replaced, only wrapped
//  (sendText), patched (existing DOM in the composer), or observed
//  (chat-scroll .msg.ai nodes via MutationObserver).
//
//  Behaviour:
//   * Adds a paperclip Import button in the chat composer between cam-btn
//     and send. Click -> native file picker -> attachment chip in chat.
//   * Listens for `doc:imported` IPC events from main so chips appear
//     even if the import happened from the overlay panel or via drag-drop.
//   * Observes newly-added .msg.ai bubbles in chat-scroll. For every
//     AI reply it finds a ```docgen``` fenced JSON block, strips it from
//     the displayed text (so the user doesn't see raw JSON), and renders
//     a preview card with [Save as PDF] (primary) + alt-format buttons.
//   * Wraps the existing `sendText()` to detect natural-language intent
//     ("import this file", "let me share a pdf", "open the file picker")
//     and auto-open the picker at send time.
// ===================================================================

(function () {
  // Guard against double-install (script tag can run more than once if the
  // page is hot-reloaded during dev).
  if (window.__chatImportInstalled) return;
  window.__chatImportInstalled = true;

  const $ = function (id) { return document.getElementById(id); };
  const esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  function humanSize(b) {
    if (!b) return '';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1).replace(/\.0$/, '') + ' KB';
    return (b / 1024 / 1024).toFixed(1).replace(/\.0$/, '') + ' MB';
  }
  function safeAttr(s) { return String(s || '').replace(/"/g, '&quot;'); }

  // ------- CSS injection (single stylesheet, idempotent) -------
  const css = document.createElement('style');
  css.id = 'chat-import-css';
  css.textContent = [
    '.import-btn{appearance:none;background:var(--panel2);border:1px solid var(--line);color:var(--txt);',
    'border-radius:10px;width:46px;cursor:pointer;font-size:17px;flex:0 0 auto;transition:.15s;',
    'display:grid;place-items:center}',
    '.import-btn:hover{background:var(--accent-soft);border-color:var(--accent-line)}',
    '.attachment-chip{display:inline-flex;align-items:center;gap:8px;background:var(--panel2);',
    'border:1px solid var(--line);border-radius:10px;padding:6px 12px;margin:6px 0 4px 0;',
    'font-size:12px;color:var(--mut);max-width:340px;cursor:pointer;transition:background .15s,border-color .15s}',
    '.attachment-chip:hover{background:var(--accent-soft);border-color:var(--accent)}',
    '.attachment-chip .att-ico{font-size:18px;flex:none;line-height:1}',
    '.attachment-chip .att-meta{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
    '.attachment-chip .att-name{color:var(--txt);font-size:12.5px;',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}',
    '.attachment-chip .att-size{color:var(--faint);font-size:10.5px}',
    '.attachment-chip .att-ext{background:var(--accent-soft);color:var(--accent);',
    'padding:1px 6px;border-radius:99px;font-size:9.5px;font-weight:600;',
    'text-transform:uppercase;letter-spacing:.5px;margin-left:4px;flex:none}',
    '.attachment-details{background:var(--panel2);border-left:2px solid var(--accent);',
    'border-radius:6px;padding:12px 14px;margin:2px 0 8px 0;max-width:380px;',
    'font-size:12px;color:var(--mut);display:none}',
    '.attachment-details.show{display:block}',
    '.attachment-details .attd-heading{font-weight:600;color:var(--txt);margin-bottom:4px;font-size:12.5px}',
    '.attachment-details .attd-meta-line{font-size:11px;color:var(--faint);margin-bottom:4px;',
    'font-family:ui-monospace,Consolas,Menlo,monospace;word-break:break-all}',
    '.attachment-details .attd-preview{font-family:ui-monospace,Consolas,Menlo,monospace;',
    'font-size:11px;color:var(--mut);max-height:120px;overflow-y:auto;white-space:pre-wrap;',
    'word-wrap:break-word;background:rgba(0,0,0,.18);padding:8px 10px;border-radius:4px;margin-top:4px}',
    '.attachment-details .attd-actions{margin-top:8px;display:flex;gap:8px}',
    '.attachment-details .attd-btn{border:1px solid var(--line);background:var(--panel);',
    'color:var(--txt);border-radius:8px;padding:5px 11px;font:inherit;font-size:11.5px;cursor:pointer}',
    '.attachment-details .attd-btn:hover{background:var(--accent-soft)}',
    '.att-status{font-size:11px;padding:2px 0;color:var(--mut)}',
    '.att-status.ok{color:var(--ok)}.att-status.bad{color:var(--bad)}',
    '.docgen-preview{background:var(--panel);border:1px solid var(--accent);',
    'border-radius:12px;padding:14px 16px;margin:8px 0;max-width:540px}',
    '.docgen-preview .dg-head{display:flex;align-items:center;gap:10px;margin-bottom:6px}',
    '.docgen-preview .dg-ico{background:var(--accent-soft);border:1px solid var(--accent-line);',
    'border-radius:50%;width:32px;height:32px;display:grid;place-items:center;font-size:16px;flex:none}',
    '.docgen-preview .dg-title-block{min-width:0;flex:1}',
    '.docgen-preview .dg-title{font-size:14px;font-weight:600;color:var(--txt);',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.docgen-preview .dg-sub{font-size:11.5px;color:var(--mut);margin-top:2px;',
    'font-style:italic}',
    '.docgen-preview .dg-sections{margin:8px 0 0 0;font-size:12px;color:var(--mut);',
    'max-height:140px;overflow-y:auto;padding-right:4px}',
    '.docgen-preview .dg-section-row{display:flex;align-items:center;gap:8px;padding:3px 0;',
    'font-size:12px;border-bottom:1px solid rgba(255,255,255,.06)}',
    '.docgen-preview .dg-section-row:last-child{border-bottom:0}',
    '.docgen-preview .dg-section-row .dg-num{background:var(--accent-soft);color:var(--accent);',
    'border-radius:99px;padding:1px 7px;font-size:10.5px;font-weight:600;min-width:24px;text-align:center}',
    '.docgen-preview .dg-actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}',
    '.docgen-preview .dg-btn{border:1px solid var(--line);background:var(--panel2);',
    'color:var(--txt);border-radius:10px;padding:7px 14px;font:inherit;font-size:12px;cursor:pointer;',
    'display:inline-flex;align-items:center;gap:6px}',
    '.docgen-preview .dg-btn:hover:not(:disabled){background:var(--accent-soft)}',
    '.docgen-preview .dg-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.docgen-preview .dg-btn-primary{background:var(--accent);color:#0a0b0d;',
    'border-color:transparent;font-weight:600}',
    '.docgen-preview .dg-btn-primary:hover:not(:disabled){opacity:.85}',
    '.docgen-preview .dg-status{font-size:11px;margin-top:8px;color:var(--mut);',
    'word-break:break-all}',
    '.docgen-preview .dg-status.ok{color:var(--ok)}',
    '.docgen-preview .dg-status.bad{color:var(--bad)}'
  ].join('');
  // Append only if not already present (idempotent across reloads).
  if (!document.getElementById('chat-import-css')) document.head.appendChild(css);

  // ----- Attachment state (for re-import on chip click) -----
  // Cached in renderer memory. main.js is the source of truth (lastDocument)
  // but we keep our own table so opening details is instant.
  const _attachments = [];
  function rememberAttachment(meta) {
    if (!meta || !meta.path) return;
    // Replace existing entry with the same path.
    const i = _attachments.findIndex(function (m) { return m && m.path === meta.path; });
    if (i >= 0) _attachments[i] = meta; else _attachments.unshift(meta);
    if (_attachments.length > 50) _attachments.pop();
  }

  // ----- Render an attachment chip -----
  function renderAttachmentChip(meta) {
    const ext = (meta.ext || '').toLowerCase();
    let ico = '\u{1F4CE}'; // paperclip
    if (ext === 'pdf') ico = '\u{1F4C4}';
    else if (/^(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(ext)) ico = '\u{1F5BC}';
    else if (/^(md|txt|log|csv|tsv)$/i.test(ext)) ico = '\u{1F4DD}';
    else if (/^(doc|docx|odt|rtf)$/i.test(ext)) ico = '\u{1F4C4}';
    else if (/^(xls|xlsx)$/i.test(ext)) ico = '\u{1F4CA}';

    const wrap = document.createElement('div');
    wrap.className = 'attachment-chip';
    wrap.dataset.path = meta.path || '';
    wrap.title = 'Click to view details or re-import this file';
    wrap.innerHTML =
      '<span class="att-ico">' + ico + '</span>' +
      '<span class="att-meta">' +
        '<span class="att-name">' + esc(meta.name || 'document') + '</span>' +
        (meta.sizeBytes ? '<span class="att-size">' + humanSize(meta.sizeBytes) + '</span>' : '') +
      '</span>' +
      '<span class="att-ext">' + esc((ext || 'file').slice(0, 4)) + '</span>';
    wrap.addEventListener('click', function () { toggleDetailsPanel(meta, wrap); });
    return wrap;
  }

  function toggleDetailsPanel(meta, anchorEl) {
    const sel = '.attachment-details[data-path="' + safeAttr(meta.path || '') + '"]';
    let existing = anchorEl.parentNode && anchorEl.parentNode.querySelector(':scope > ' + sel);
    if (existing) { existing.classList.toggle('show'); return; }

    const wrap = document.createElement('div');
    wrap.className = 'attachment-details show';
    wrap.dataset.path = meta.path || '';

    const head = document.createElement('div');
    head.className = 'attd-heading';
    head.textContent = meta.name || 'Document';

    const meta1 = document.createElement('div');
    meta1.className = 'attd-meta-line';
    meta1.textContent = [
      (meta.ext || '').toUpperCase(),
      meta.sizeBytes ? humanSize(meta.sizeBytes) : '',
      meta.path || ''
    ].filter(Boolean).join(' \u00B7 ');

    const preview = document.createElement('div');
    preview.className = 'attd-preview';
    preview.textContent = meta.preview ? meta.preview : '(no preview available)';

    const actions = document.createElement('div');
    actions.className = 'attd-actions';
    const reImport = document.createElement('button');
    reImport.className = 'attd-btn';
    reImport.textContent = 'Re-import';
    reImport.addEventListener('click', async function () {
      reImport.disabled = true; reImport.textContent = 'Importing\u2026';
      const status = showInlineStatus(wrap, 'Re-importing\u2026', '');
      try {
        if (!window.bridge || !window.bridge.importDocPath) throw new Error('importDocPath unavailable');
        const r = await window.bridge.importDocPath(meta.path);
        if (r && r.ok) {
          showInlineStatus(wrap, '\u2713 Re-imported: ' + (r.name || meta.name), 'ok');
          // Refresh preview from the new return shape if available.
          if (r.preview) preview.textContent = r.preview;
          if (r.sizeBytes) meta1.textContent = [
            (meta.ext || '').toUpperCase(),
            humanSize(r.sizeBytes),
            meta.path || ''
          ].filter(Boolean).join(' \u00B7 ');
        } else {
          showInlineStatus(wrap, '\u26A0 ' + ((r && r.error) || 'unknown error'), 'bad');
        }
      } catch (e) {
        showInlineStatus(wrap, '\u26A0 ' + (e && e.message ? e.message : e), 'bad');
      } finally {
        reImport.disabled = false; reImport.textContent = 'Re-import';
      }
    });
    actions.appendChild(reImport);
    wrap.appendChild(head);
    wrap.appendChild(meta1);
    wrap.appendChild(preview);
    wrap.appendChild(actions);
    if (anchorEl.parentNode) anchorEl.parentNode.insertBefore(wrap, anchorEl.nextSibling);
  }

  function showInlineStatus(wrap, text, cls) {
    let el = wrap.querySelector(':scope > .att-status');
    if (!el) {
      el = document.createElement('div');
      el.className = 'att-status';
      wrap.appendChild(el);
    }
    el.textContent = text;
    el.className = 'att-status ' + (cls || '');
    // Auto-clear "ok" status after a few seconds so the panel doesn't accumulate
    // stale green checks.
    if (cls === 'ok') setTimeout(function () {
      if (el.textContent === text) { el.textContent = ''; el.className = 'att-status'; }
    }, 4000);
  }

  // ----- Add the Import button to the chat composer -----
  function ensureImportButton() {
    if ($('import-btn')) return;
    const composer = document.querySelector('#view-chat .composer');
    if (!composer) return false;
    const send = composer.querySelector('.send') || composer.lastElementChild;
    if (!send) return false;
    const btn = document.createElement('button');
    btn.id = 'import-btn';
    btn.className = 'import-btn';
    btn.title = 'Import a document (PDF, image, etc.)';
    btn.setAttribute('aria-label', 'Import document');
    btn.textContent = '\u{1F4CE}'; // paperclip
    btn.addEventListener('click', function () { pickAndShowImport(); });
    composer.insertBefore(btn, send);
    return true;
  }

  async function pickAndShowImport() {
    if (!window.bridge || !window.bridge.importDoc) {
      console.warn('[chat-import] importDoc bridge unavailable');
      return;
    }
    const target = findLastUserMessage() || ensureSystemRow();
    const status = document.createElement('div');
    status.className = 'att-status';
    status.textContent = 'Choose a document\u2026';
    target.appendChild(status);
    try {
      const r = await window.bridge.importDoc();
      status.remove();
      if (!r || !r.ok) {
        const bad = document.createElement('div');
        bad.className = 'att-status bad';
        bad.textContent = '\u26A0 ' + ((r && r.error) || 'Could not import that file.');
        target.appendChild(bad);
        return;
      }
      rememberAttachment(r);
      target.appendChild(renderAttachmentChip(r));
      const scroll = $('chat-scroll');
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
    } catch (e) {
      status.remove();
      const bad = document.createElement('div');
      bad.className = 'att-status bad';
      bad.textContent = '\u26A0 ' + (e && e.message ? e.message : e);
      target.appendChild(bad);
    }
  }

  function findLastUserMessage() {
    const scroll = $('chat-scroll');
    if (!scroll) return null;
    const msgs = scroll.querySelectorAll('.msg.user');
    if (!msgs.length) return null;
    return msgs[msgs.length - 1];
  }

  function ensureSystemRow() {
    const scroll = $('chat-scroll');
    if (!scroll) return null;
    const row = document.createElement('div');
    row.className = 'msg sys';
    row.textContent = 'Imported';
    scroll.appendChild(row);
    return row;
  }

  // ----- Natural-language import trigger (wraps existing sendText) -----
  //  Tight, anchored regex - matches phrases like "import a pdf", "let me
  //  share a file", "open the file picker". Conservative on purpose: false
  //  positives are worse than missing genuine intent (the user can always
  //  click the Import button).
  //
  //  Important: each pattern requires an explicit verb-noun pair NEAR EACH
  //  OTHER. "I want to import a python library" matches pattern 1 because
  //  "library" isn't in our noun list - but "I want to import an image" matches
  //  because "image" IS in the list. "Let me share your thoughts" doesn't
  //  match (no file-like noun). "Give me a moment to import better image
  //  upscaling" matches because "image upscaling" is hard - the user has the
  //  Import button for the more ambiguous cases.
  function shouldOpenImportOnSend(text) {
    const t = String(text || '').toLowerCase().trim();
    if (t.length < 6 || t.length > 200) return false;
    // Strip a leading prefix so the verb-noun pair sits AT THE START of the
    // match position - this is what kills most "metaphorical import" cases
    // (e.g. "share your thoughts" - "your thoughts" has no file noun).
    const norm = t.replace(/^(please,?\s+|caryl,?\s+|hey caryl,?\s+|hi,?\s+|can you,?\s+|could you,?\s+|i want to\s+|i'd like to\s+|let me\s+|let's\s+)+/, '');
    // The unlock phrases we want to fire on - extracted from norm. After
    // the prefix strip, an actual "import <noun>" intent starts with verb
    // immediately. Anything with the verb AFTER 25 other chars is almost
    // certainly not an import command.
    const slice = norm || t;
    const patterns = [
      // Pattern 1: explicit import/attach verb DIRECTLY followed (within 4 words)
      // by a file-like noun. Tighter gap than before to kill "I want to import
      // support for image formats" - now requires ~ "import the file/pdf/...".
      /\b(import|attach|upload)\b[^.\n!?]{0,30}\b(my|the|a|an|this|that)?\s*(file|document|pdf|image|photo|picture|screenshot|csv|xlsx|docx|doc|txt)\b/,
      // Pattern 2: explicit "open the file picker" request.
      /\bopen\b[^.\n!?]{0,12}\b(the\s+)?(file\s+)?(picker|dialog|chooser|explorer)\b/,
      // Pattern 3: "let me share a pdf" - verb + leading article + file-noun at
      // the start (post-prefix-strip). Drops "share" from elsewhere to avoid
      // "share this document with me please" false-positives.
      /^share\s+(a|an|the|my)\s+(file|document|pdf|picture|image|photo)\b/,
      // Pattern 4: "share this/that/the/my file" - kept narrow by requiring the
      // demonstrative + file-noun adjacency (no abstract "my thoughts" misses).
      /^share\s+(this|that|the|my)\s+(file|document|pdf|picture|image|photo)\b/
    ];
    return patterns.some(function (re) { return re.test(slice); });
  }

  let _sendTextPatched = false;
  function patchSendText() {
    if (_sendTextPatched || typeof sendText !== 'function') return;
    _sendTextPatched = true;
    const original = sendText;
    // Replace globally (this script runs in the same global scope as the
    // inline <script> block in renderer/index.html).
    window.sendText = function () {
      try {
        const input = $('chat-input');
        const t = (input && input.value || '').trim();
        if (shouldOpenImportOnSend(t) && window.bridge && window.bridge.importDoc) {
          // Fire-and-forget; main.js broadcasts doc:imported back to us so the
          // chip appears regardless of which window captured the picker.
          window.bridge.importDoc().catch(function (e) {
            console.warn('[chat-import] NL-triggered import failed:', e);
          });
        }
      } catch (_e) {}
      return original.apply(this, arguments);
    };
  }

  // ----- DOCGEN block detection in AI messages -----
  // The AI may emit a ```docgen fenced JSON block in its reply. We extract that
  // block, hide it from the displayed text, and render a preview card with
  // [Save as PDF] + alt-format buttons.
  function extractDocgenBlocks(text) {
    if (!text) return { remainingText: '', blocks: [] };
    const blocks = [];
    let remaining = String(text);
    // ```docgen\n<json>\n```  -- multi-line json body
    const re = /```docgen[ \t]*\n([\s\S]*?)\n```/g;
    let m;
    while ((m = re.exec(remaining)) !== null) {
      try {
        const obj = JSON.parse(m[1]);
        blocks.push(obj);
      } catch (e) {
        console.warn('[chat-docgen] parse failed on block:', e);
      }
    }
    remaining = remaining.replace(re, '').trim();
    return { remainingText: remaining, blocks: blocks };
  }

  function renderDocgenPreview(block) {
    const format = (block.format || 'pdf').toLowerCase();
    const title = block.title || 'Caryl Document';
    const subtitle = block.subtitle || '';
    const sections = Array.isArray(block.sections) ? block.sections : [];
    const meta = block.meta || {};

    const wrap = document.createElement('div');
    wrap.className = 'docgen-preview';
    wrap.dataset.docgenId = 'dg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

    const head = document.createElement('div');
    head.className = 'dg-head';
    head.innerHTML =
      '<span class="dg-ico">\u{1F4C4}</span>' +
      '<div class="dg-title-block">' +
        '<div class="dg-title">' + esc(title) + '</div>' +
        (subtitle ? '<div class="dg-sub">' + esc(subtitle) + '</div>' : '') +
      '</div>';
    wrap.appendChild(head);

    if (Object.keys(meta).length) {
      const metaLine = document.createElement('div');
      metaLine.style.cssText = 'font-size:11px;color:var(--mut);margin-bottom:6px;';
      metaLine.textContent = Object.keys(meta).map(function (k) {
        return esc(k) + ': ' + esc(String(meta[k]));
      }).join('  \u00B7  ');
      wrap.appendChild(metaLine);
    }

    if (sections.length) {
      const sec = document.createElement('div');
      sec.className = 'dg-sections';
      sections.forEach(function (s, i) {
        const row = document.createElement('div');
        row.className = 'dg-section-row';
        const items = [];
        if (Array.isArray(s.list) && s.list.length) items.push(s.list.length + ' items');
        if (s.content) items.push(String(s.content).length + ' chars');
        row.innerHTML =
          '<span class="dg-num">' + (i + 1) + '</span>' +
          '<span style="flex:1">' + esc(s.heading || '(untitled)') + '</span>' +
          (items.length ? '<span style="color:var(--faint);font-size:10.5px">' + esc(items.join(' \u00B7 ')) + '</span>' : '');
        sec.appendChild(row);
      });
      wrap.appendChild(sec);
    }

    const labels = { pdf: 'Save as PDF', md: 'Save as Markdown', html: 'Save as HTML', txt: 'Save as Text' };
    const actions = document.createElement('div');
    actions.className = 'dg-actions';

    const primary = document.createElement('button');
    primary.className = 'dg-btn dg-btn-primary';
    primary.textContent = '\u2B07 ' + (labels[format] || ('Save as ' + format.toUpperCase()));
    primary.addEventListener('click', function () { saveDocBlock(block, format, wrap); });
    actions.appendChild(primary);

    ['pdf', 'md', 'html', 'txt'].filter(function (f) { return f !== format; }).forEach(function (f) {
      const b = document.createElement('button');
      b.className = 'dg-btn';
      b.textContent = labels[f];
      b.addEventListener('click', function () { saveDocBlock(block, f, wrap); });
      actions.appendChild(b);
    });
    wrap.appendChild(actions);

    const status = document.createElement('div');
    status.className = 'dg-status';
    wrap.appendChild(status);

    return wrap;
  }

  async function saveDocBlock(block, format, previewEl) {
    if (!window.bridge || !window.bridge.generateDoc || !window.bridge.saveDoc) {
      console.warn('[chat-docgen] required bridges missing');
      return;
    }
    const status = previewEl.querySelector(':scope > .dg-status');
    const buttons = previewEl.querySelectorAll(':scope > .dg-actions .dg-btn');
    buttons.forEach(function (b) { b.disabled = true; });
    if (status) { status.textContent = '\u23F3 Generating\u2026'; status.className = 'dg-status'; }
    try {
      const gen = await window.bridge.generateDoc(Object.assign({}, block, { format: format }));
      if (!gen || !gen.ok) {
        if (status) {
          status.textContent = '\u26A0 Generate failed: ' + ((gen && gen.error) || 'unknown');
          status.className = 'dg-status bad';
        }
        return;
      }
      const defaultFilename = gen.filename || ((block.title || 'caryl-document') + '.' + format);
      const payload = (format === 'pdf')
        ? { format: format, buffer: gen.pdfBuffer, defaultFilename: defaultFilename }
        : { format: format, text: gen.markdown || gen.text || gen.html || '', defaultFilename: defaultFilename };
      const saved = await window.bridge.saveDoc(payload);
      if (saved && saved.ok) {
        if (status) {
          status.innerHTML = '\u2713 Saved to <a href="#" data-open-file="' + esc(saved.path) + '">' +
            esc(saved.path) + '</a>';
          status.className = 'dg-status ok';
        }
      } else if (saved && saved.canceled) {
        if (status) { status.textContent = 'Save cancelled.'; status.className = 'dg-status'; }
      } else {
        if (status) {
          status.textContent = '\u26A0 Save failed: ' + ((saved && saved.error) || 'unknown');
          status.className = 'dg-status bad';
        }
      }
    } catch (e) {
      if (status) {
        status.textContent = '\u26A0 ' + (e && e.message ? e.message : e);
        status.className = 'dg-status bad';
      }
    } finally {
      buttons.forEach(function (b) { b.disabled = false; });
    }
  }

  // ----- Observe the chat thread for new AI messages and process each -----
  // CRITICAL behaviour: in this app `streamChat()` appends tokens IN-PLACE to
  // an existing .msg.ai bubble (text-only updates - no DOM changes). A naive
  // childList observer NEVER fires on those, so a one-shot extraction on
  // bubble-creation reads an empty string and misses the ```docgen``` fence that
  // arrives 4s later. To catch in-place streaming we:
  //   (1) append the preview card as a sibling INSIDE #chat-scroll, NEVER
  //       rewriting the .msg.ai bubble's innerHTML (would clobber whatever
  //       markdown / formatting the existing renderer already drew);
  //   (2) hide the raw ```docgen``` source by stopping it at the BUBBLE
  //       level  - replace its innerHTML ONLY after we've already rendered
  //       the card, so existing content isn't disturbed;
  //   (3) trigger extraction on EITHER (a) bubble creation, (b) character-data
  //       mutations inside the bubble, or (c) a custom `caryl:stream-end`
  //       DOM event the streaming code already fires. Here we wire (a)+(b).
  // Stable fingerprint of a parsed block - used so post-fence streaming chars
  // don't trigger duplicate preview cards. title + section count + first
  // section heading is robust enough for dedupe without false-collision risk.
  function blockFingerprint(block) {
    try {
      const title = String((block && block.title) || '');
      const secs = Array.isArray(block && block.sections) ? block.sections : [];
      const firstHead = String((secs[0] && secs[0].heading) || '');
      return title + '|' + secs.length + '|' + firstHead;
    } catch (_e) { return ''; }
  }

  // Whatever existing preview cards for THIS bubble are already in the chat
  // thread - we re-scan the bubble's siblings for cards whose fingerprint
  // matches so we don't insert duplicates when char-data fires repeatedly.
  function alreadyHasPreviewFor(scroll, anchorNode, fingerprint) {
    if (!scroll || !fingerprint) return false;
    let n = anchorNode && anchorNode.nextSibling;
    while (n) {
      if (n.nodeType === 1 && n.classList && n.classList.contains('docgen-preview') &&
        n.__docgenFingerprint === fingerprint) return true;
      n = n.nextSibling;
    }
    return false;
  }

  function processAIMessage(node) {
    if (!node || node.nodeType !== 1) return;
    if (!(node.classList && node.classList.contains('ai'))) return;
    const text = node.innerText || node.textContent || '';
    const extracted = extractDocgenBlocks(text);
    if (!extracted.blocks.length) {
      // No blocks - nothing to render. Don't set the processed flag so a
      // later edit that adds blocks can still trigger re-processing.
      return;
    }
    // Render preview cards as siblings in #chat-scroll (placed AFTER bubble).
    // Dedupe by per-block fingerprint so post-fence streaming chars don't
    // re-append the same card on every animation frame.
    const scroll = $('chat-scroll');
    if (scroll) {
      extracted.blocks.forEach(function (block) {
        const fp = blockFingerprint(block);
        const preview = renderDocgenPreview(block);
        preview.__docgenFingerprint = fp;
        if (!alreadyHasPreviewFor(scroll, node, fp)) {
          scroll.insertBefore(preview, node.nextSibling);
        }
      });
      node.__docgenProcessed = true;
    }
    // Hide the raw ```docgen``` source inside the bubble WITHOUT touching any
    // markdown formatting the renderer already drew. Split the bubble on the
    // first ```docgen fence: keep only the prose before it as the bubble's
    // innerHTML; ignore any later content (the AI's prose after the fence has
    // no value once the doc is generated). This is a conservative measure to
    // avoid clobbering existing markup.
    //
    // TODO: replace innerHTML clearing with text-node-level fence hiding (wrap
    // the ```docgen``` text in <span style="display:none">) if/when the chat
    // bubble renderer starts producing real markdown markup (links, code
    // blocks). Today's renderer writes plain text so the rewrite is safe;
    // that won't be true if structure ever appears.
    const fenceOpen = text.indexOf('```docgen');
    if (fenceOpen >= 0 && node.__docgenInnerHtmlFixed !== true) {
      node.__docgenInnerHtmlFixed = true;
      const prose = text.slice(0, fenceOpen).trim();
      node.innerHTML = '';
      const t = document.createTextNode(prose);
      node.appendChild(t);
    }
  }

  function observeChat() {
    const scroll = $('chat-scroll');
    if (!scroll) {
      setTimeout(observeChat, 220);
      return;
    }
    // One observer at chat-scroll for childlist (catches new .msg.ai bubbles),
    // AND inside each .msg.ai we attach a per-bubble character-data observer
    // so in-place streaming text-changes (the app appends tokens inline)
    // trigger re-extraction once the ```docgen fence has fully arrived.
    const obs = new MutationObserver(function (mutations) {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!node || node.nodeType !== 1) continue;
          if (node.classList && node.classList.contains('ai')) {
            processAIMessage(node);
            wireBubbleCharacterObserver(node);
          } else if (node.querySelectorAll) {
            const inner = node.querySelectorAll('.msg.ai');
            for (let i = 0; i < inner.length; i++) {
              processAIMessage(inner[i]);
              wireBubbleCharacterObserver(inner[i]);
            }
          }
        }
      }
    });
    obs.observe(scroll, { childList: true, subtree: true });
    // Process any existing AI messages so backfill works after a reload.
    const existing = scroll.querySelectorAll && scroll.querySelectorAll('.msg.ai');
    if (existing) {
      for (let i = 0; i < existing.length; i++) {
        processAIMessage(existing[i]);
        wireBubbleCharacterObserver(existing[i]);
      }
    }
  }

  // Per-bubble observer: catches IN-PLACE streaming text appends. The app
  // appends tokens into an existing .msg.ai bubble as character data, so
  // childList doesn't fire - but `characterData` mutations do. We re-evaluate
  // after every text change; extraction is idempotent thanks to the
  // `__docgenProcessed` guard on the bubble.
  function wireBubbleCharacterObserver(bubble) {
    if (!bubble || bubble.__docgenCharObsInstalled) return;
    bubble.__docgenCharObsInstalled = true;
    try {
      const co = new MutationObserver(function () {
        // Debounce to avoid re-extracting on every single char-append (would
        // thrash). Single rAF tick is plenty.
        if (bubble.__docgenRafPending) return;
        bubble.__docgenRafPending = true;
        requestAnimationFrame(function () {
          bubble.__docgenRafPending = false;
          // Reset processed-flag so re-extraction actually happens, then run.
          // Wait until the closing fence ``` arrives to avoid half-extracting
          // a block whose JSON is still streaming in.
          const t = bubble.innerText || bubble.textContent || '';
          if (t.indexOf('```docgen') !== -1 && t.indexOf('```', t.indexOf('```docgen') + 9) !== -1) {
            bubble.__docgenProcessed = false;
            processAIMessage(bubble);
          }
        });
      });
      co.observe(bubble, { characterData: true, subtree: true, childList: true });
      bubble.__docgenCharObs = co;
    } catch (_e) { /* observer wiring is best-effort - chat still works */ }
  }

  // ----- Listen for cross-window `doc:imported` events -----
  // Fires from main.js whenever ANY renderer window successfully imports a
  // file. We mirror that import as an attachment chip in the chat thread here.
  if (window.bridge && window.bridge.onDocImported) {
    try {
      window.bridge.onDocImported(function (meta) {
        if (!meta || !meta.path) return;
        rememberAttachment(meta);
        const target = findLastUserMessage() || ensureSystemRow();
        if (!target) return;
        // Replace any existing chip for the same path (re-imports).
        const existing = target.querySelector(
          '.attachment-chip[data-path="' + safeAttr(meta.path) + '"]');
        if (existing) existing.remove();
        target.appendChild(renderAttachmentChip(meta));
        const scroll = $('chat-scroll');
        if (scroll) scroll.scrollTop = scroll.scrollHeight;
      });
    } catch (e) { console.warn('[chat-import] onDocImported wiring failed:', e); }
  }

  // ----- Drag-and-drop files into the chat composer / chat-scroll -----
  // Calls importDocPath on dropped files so they get auto-imported (main will
  // fire doc:imported which our listener picks up).
  function wireFileDragDrop() {
    const targets = [$('chat-scroll'), document.querySelector('#view-chat .composer')].filter(Boolean);
    if (!targets.length) { setTimeout(wireFileDragDrop, 220); return; }
    function isFileDrag(e) {
      return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1;
    }
    targets.forEach(function (target) {
      let depth = 0;
      target.addEventListener('dragenter', function (e) {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        depth++;
        target.classList.add('chat-dragging');
      });
      target.addEventListener('dragover', function (e) {
        if (!isFileDrag(e)) return;
        e.preventDefault();
      });
      target.addEventListener('dragleave', function () {
        depth = Math.max(0, depth - 1);
        if (depth === 0) target.classList.remove('chat-dragging');
      });
      target.addEventListener('drop', async function (e) {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        depth = 0;
        target.classList.remove('chat-dragging');
        const files = e.dataTransfer.files;
        if (!files || !files.length) return;
        if (!window.bridge || !window.bridge.getPathForFile || !window.bridge.importDocPath) return;
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const p = window.bridge.getPathForFile(file);
          if (!p) continue;
          window.bridge.importDocPath(p).catch(function (_e) {});
        }
      });
    });
  }

  // ----- Boot -----
  function boot() {
    // VMs may run this script before DOMContentLoaded; retry on next tick.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
      return;
    }
    // The chat view may not be active right now; the Import button is added
    // once but stays in the DOM (the chat view is always rendered, just
    // hidden when not active).
    if (!ensureImportButton()) setTimeout(boot, 220);
    patchSendText();
    observeChat();
    wireFileDragDrop();
  }
  boot();
})();
