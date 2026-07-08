// lib/docgen.js
// ------------------------------------------------------------------
//  Document generation for Caryl.ai.
//
//  INPUT SHAPE (from the AI's ```docgen fenced block, EXACTLY this):
//    {
//      "format": "pdf" | "html" | "md" | "txt",
//      "title":   "Your Personalized Diet and Workout Plan",
//      "subtitle":"After your physique check",
//      "meta":    { "for":"you", "equipment":"3 resistance ropes + bodyweight" },
//      "sections":[
//        { "heading":"Overview", "subtitle":"...", "content":"...", "list":["..."],
//          "pills":["CARDIO","STRENGTH"], "note":"..." , "divider": true }
//      ]
//    }
//
//  OUTPUT:
//    format=pdf  -> Buffer (rendered via hidden BrowserWindow + printToPDF),
//                   filename "sanitized-title.pdf"
//    format=html -> string, filename "...html"
//    format=md   -> string, filename "...md"
//    format=txt  -> string, filename "...txt"
//
//  Rendering pipeline:
//    1. renderSectionsHtml(...) -> CSS-styled A4 document
//    2a. PDF: load into hidden BrowserWindow, webContents.printToPDF, return Buffer
//    2b. non-PDF: convert via renderSectionsHtml / generateMarkdown / generateText
//
//  Style choices:
//    * Helvetica Neue / Segoe UI stack (system-safe, prints crisply)
//    * @page A4 with 16/14/18/14 mm margins; printToPDF honors these via preferCSSPageSize
//    * Cover page: title (28pt) + subtitle + meta as a "definition list" feel
//    * Sections sit on <h1 class="section"> so they pick up heading styles only
//    * "note" pulled aside in a subtle amber left-border callout
//    * "list" rendered as <ul><li>; "pills" as inline labels
// ------------------------------------------------------------------

'use strict';

// Sanitize a string into a safe cross-platform filename. Keeps letter/digit/._-,
// collapses whitespace to underscore, caps at ~80 chars.
function safeFilename(s, ext) {
  const base = String(s || 'caryl-document')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '') // strip forbidden chars
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80) || 'caryl-document';
  return base + (ext ? '.' + ext.replace(/^\.+/, '') : '');
}

// Escape HTML safely. Markers pass through verbatim so they can be re-decoded
// afterwards by renderSectionsHtml (currently we use a simple split-on-marker
// pattern, no live encoding so this helper is intentionally minimal).
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Light inline-Markdown: bold (**...** or __...__), italic (*...* / _..._),
// inline code (`...`), explicit <br/> on line breaks. We do not promote headings
// inside content (sections handle that) nor lists (rendered as <ul> separately).
function inlineMd(s) {
  if (s == null || s === '') return '';
  let t = escHtml(s);
  // Inline code first so its content isn't accidentally bolded/italicised.
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // Italic (avoid burning underscores inside identifiers - require word boundaries)
  t = t.replace(/(^|[\s(])_([^_\n]+?)_(?=$|[\s).,;:!?])/g, '$1<em>$2</em>');
  t = t.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
  // Preserve user line breaks
  t = t.replace(/\r?\n/g, '<br/>');
  return t;
}

// Render the structured sections into a full HTML document with print-friendly CSS.
// opts: { title, subtitle, meta, createdAt, accentColor? }
// sections: array of section objects as documented at the top.
function renderSectionsHtml(sections, opts) {
  opts = opts || {};
  const title = String(opts.title || 'Caryl Document').trim() || 'Caryl Document';
  const subtitle = String(opts.subtitle || '').trim();
  const meta = (opts.meta && typeof opts.meta === 'object') ? opts.meta : {};
  const createdAt = opts.createdAt instanceof Date ? opts.createdAt : new Date();
  const accent = opts.accentColor || '#0c1018';

  const css = [
    // A4 with breathing room. The renderer's printToPDF honors this via
    // preferCSSPageSize:true. The .4/.6 margin numbers in the call are belt-
    // and-braces for older Electron that ignored that flag.
    '@page { size: A4; margin: 16mm 14mm 18mm 14mm; }',
    'html,body{margin:0;padding:0;color:#1a1d24;background:#fff;' +
      'font-family:"Helvetica Neue","Segoe UI",Arial,sans-serif;' +
      '-webkit-print-color-adjust:exact;print-color-adjust:exact;}',
    'body{padding:36px 32px;line-height:1.55;font-size:11pt;hyphens:auto;}',
    'h1.cover-title{font-size:30pt;font-weight:700;letter-spacing:-0.02em;' +
      'margin:14px 0 10px;line-height:1.12;color:' + escHtml(accent) + '}',
    '.cover-sub{font-size:13pt;color:#575c66;margin:6px 0 30px;max-width:560px;line-height:1.45}',
    '.cover-meta{border-top:1px solid #dde1e6;padding-top:14px;margin-top:18px;' +
      'font-size:10pt;color:#6f7682;line-height:1.75}',
    '.cover-meta b{color:#2c313a;font-weight:600}',
    '.cover-meta div{margin:1px 0}',
    'h1.section{font-size:17pt;font-weight:700;margin:26px 0 6px;color:#0c1018;' +
      'page-break-after:avoid}',
    '.section-sub{font-size:11pt;color:#5b6472;font-style:italic;margin-bottom:10px}',
    'p{margin:7px 0 10px;text-align:left}',
    'ul{margin:8px 0 14px;padding-left:22px}',
    'ul li{margin:4px 0;line-height:1.45}',
    'ol{margin:8px 0 14px;padding-left:22px}',
    'ol li{margin:4px 0;line-height:1.45}',
    'code,.mono{font-family:"JetBrains Mono","Consolas","Menlo",monospace;' +
      'font-size:9.8pt;background:#f3f5f8;padding:2px 6px;border-radius:3px;color:#1a1d24}',
    '.note{background:#fff8e8;border-left:3px solid #f5b53d;padding:10px 14px;' +
      'margin:12px 0;border-radius:4px;font-size:10.5pt;color:#574219;page-break-inside:avoid}',
    '.divider,.hr{border:none;border-top:1px solid #e5e7eb;margin:18px 0}',
    '.pill{display:inline-block;background:#f0f3f7;border:1px solid #dde1e6;' +
      'border-radius:99px;padding:3px 11px;font-size:9.5pt;color:#2c313a;' +
      'margin:0 6px 4px 0}',
    '.cover{page-break-after:auto}',
    '.end-footer{margin-top:40px;padding-top:14px;border-top:1px solid #dde1e6;' +
      'font-size:9pt;color:#6f7682;text-align:left}',
    // Auto page-break for long sections
    '.keep-together{page-break-inside:avoid}'
  ].join('\n');

  // Build the meta table on the cover. Stable key order = Object.keys order.
  const metaRows = Object.keys(meta).filter(function (k) {
    return meta[k] != null && String(meta[k]).trim() !== '';
  }).map(function (k) {
    return '<div><b>' + escHtml(k) + ':</b> ' + inlineMd(meta[k]) + '</div>';
  }).join('');
  const dateStr = createdAt.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  // Build each section. Defensively handle every field so a malformed AI block
  // (e.g. "list":"string" instead of array) never crashes the renderer - we
  // just drop the bad field silently.
  const sectionsHtml = (Array.isArray(sections) ? sections : []).map(function (sec) {
    if (!sec || typeof sec !== 'object') return '';
    let html = '';
    if (sec.heading) html += '<h1 class="section">' + escHtml(String(sec.heading)) + '</h1>';
    if (sec.subtitle) html += '<div class="section-sub">' + inlineMd(sec.subtitle) + '</div>';
    if (sec.content) {
      // If content has multiple paragraphs (blank line), split into <p>'s.
      const paragraphs = String(sec.content).split(/\r?\n\r?\n+/);
      html += paragraphs.map(function (p) {
        const trimmed = p.trim();
        return trimmed ? '<p>' + inlineMd(trimmed) + '</p>' : '';
      }).join('');
    }
    if (Array.isArray(sec.list) && sec.list.length) {
      const ordered = !!sec.ordered;
      const tag = ordered ? 'ol' : 'ul';
      html += '<' + tag + '>' + sec.list.map(function (item) {
        if (item == null) return '';
        return '<li>' + inlineMd(String(item)) + '</li>';
      }).join('') + '</' + tag + '>';
    }
    if (Array.isArray(sec.pills) && sec.pills.length) {
      html += '<div style="margin:10px 0">' + sec.pills.map(function (p) {
        return '<span class="pill">' + escHtml(String(p)) + '</span>';
      }).join('') + '</div>';
    }
    if (sec.note) html += '<div class="note">' + inlineMd(sec.note) + '</div>';
    if (sec.divider) html += '<hr class="divider"/>';
    return html;
  }).join('');

  // Inject into the doc skeleton. Note: title is marked role="heading" for AT,
  // but this is a print doc - AT tags are no-op in printToPDF.
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8"/>',
    '<title>' + escHtml(title) + '</title>',
    '<style>' + css + '</style>',
    '</head><body>',
    '<div class="cover">',
    '<h1 class="cover-title">' + escHtml(title) + '</h1>',
    subtitle ? '<div class="cover-sub">' + escHtml(subtitle) + '</div>' : '',
    '<div class="cover-meta">',
      metaRows,
      '<div><b>Generated:</b> ' + dateStr + '</div>',
    '</div>',
    '</div>',
    '<hr class="divider"/>',
    sectionsHtml,
    '<div class="end-footer">Prepared by Caryl.ai &middot; ' + dateStr + '</div>',
    '</body></html>'
  ].join('');
}

// Markdown output: emits valid CommonMark. Headings always ## (level 2) so they
// sit consistently below the title. Pills render as inline code chips so they
// stand out without our CSS.
function generateMarkdown(opts) {
  const sections = Array.isArray(opts && opts.sections) ? opts.sections : [];
  const title = String((opts && opts.title) || 'Caryl Document').trim() || 'Caryl Document';
  const subtitle = String((opts && opts.subtitle) || '').trim();
  const createdAt = (opts && opts.createdAt instanceof Date) ? opts.createdAt : new Date();
  const meta = (opts && opts.meta && typeof opts.meta === 'object') ? opts.meta : {};

  let out = '# ' + title + '\n\n';
  if (subtitle) out += '> ' + subtitle + '\n\n';
  out += '> Generated by Caryl.ai on ' + createdAt.toLocaleDateString() + '\n\n';

  Object.keys(meta).forEach(function (k) {
    if (meta[k] == null || String(meta[k]).trim() === '') return;
    out += '- **' + k + ':** ' + String(meta[k]).trim() + '\n';
  });
  if (Object.keys(meta).length) out += '\n';

  sections.forEach(function (sec) {
    if (!sec || typeof sec !== 'object') return;
    if (sec.heading) out += '## ' + String(sec.heading).trim() + '\n\n';
    if (sec.subtitle) out += '_' + String(sec.subtitle).trim() + '_\n\n';
    if (sec.content) out += String(sec.content).trim() + '\n\n';
    if (Array.isArray(sec.list) && sec.list.length) {
      const ordered = !!sec.ordered;
      sec.list.forEach(function (item, i) {
        if (ordered) out += (i + 1) + '. ' + String(item || '').trim() + '\n';
        else out += '- ' + String(item || '').trim() + '\n';
      });
      out += '\n';
    }
    if (Array.isArray(sec.pills) && sec.pills.length) {
      out += sec.pills.map(function (p) { return '`' + String(p).trim() + '`'; }).join(' ') + '\n\n';
    }
    if (sec.note) out += '> ' + String(sec.note).trim() + '\n\n';
    if (sec.divider) out += '---\n\n';
  });

  return { markdown: out, filename: safeFilename(title, 'md') };
}

// Plain text output: underlines the section headings so the structure is
// obvious even in a Notepad window.
function generateText(opts) {
  const sections = Array.isArray(opts && opts.sections) ? opts.sections : [];
  const title = String((opts && opts.title) || 'Caryl Document').trim() || 'Caryl Document';
  const subtitle = String((opts && opts.subtitle) || '').trim();
  const createdAt = (opts && opts.createdAt instanceof Date) ? opts.createdAt : new Date();
  const meta = (opts && opts.meta && typeof opts.meta === 'object') ? opts.meta : {};

  // Underline length matches the title/heading itself - the convention used
  // by most shell-style title rendering.
  const underline = function (s, ch) { return s + '\n' + ch.repeat(s.length) + '\n'; };
  // Headings are uppercased so structure is obvious even in a plain Notepad
  // window (no colour, no font weight). The meta key stays as the user wrote
  // it; only the value of the title/heading is uppercased.
  let out = underline(title.toUpperCase(), '=') + '\n';
  if (subtitle) out += subtitle + '\n';
  out += 'Generated by Caryl.ai on ' + createdAt.toLocaleDateString() + '\n\n';

  Object.keys(meta).forEach(function (k) {
    if (meta[k] == null || String(meta[k]).trim() === '') return;
    out += k + ': ' + String(meta[k]).trim() + '\n';
  });
  if (Object.keys(meta).length) out += '\n';

  sections.forEach(function (sec) {
    if (!sec || typeof sec !== 'object') return;
    if (sec.heading) out += '\n' + underline(String(sec.heading).trim().toUpperCase(), '-');
    if (sec.subtitle) out += String(sec.subtitle).trim() + '\n\n';
    if (sec.content) out += String(sec.content).trim() + '\n';
    if (Array.isArray(sec.list) && sec.list.length) {
      sec.list.forEach(function (item, i) {
        out += '  ' + (sec.ordered ? ((i + 1) + '. ') : '- ') + String(item || '').trim() + '\n';
      });
      out += '\n';
    }
    if (Array.isArray(sec.pills) && sec.pills.length) {
      out += '  [' + sec.pills.map(function (p) { return String(p).trim(); }).join(' | ') + ']\n';
    }
    if (sec.note) out += '  >> ' + String(sec.note).trim() + '\n';
  });

  return { text: out, filename: safeFilename(title, 'txt') };
}

// HTML output: just wrap our printed HTML in a <pre>-free body. We DO NOT
// auto-open anything; the renderer is responsible for showing preview + Save.
function generateHtml(opts) {
  const html = renderSectionsHtml(opts && opts.sections, {
    title: opts && opts.title,
    subtitle: opts && opts.subtitle,
    meta: opts && opts.meta,
    createdAt: (opts && opts.createdAt instanceof Date) ? opts.createdAt : new Date(),
    accentColor: opts && opts.accentColor
  });
  return { html: html, filename: safeFilename(opts && opts.title, 'html') };
}

// Render a PDF Buffer. Creates a HIDDEN BrowserWindow, points it at our
// in-memory HTML via a data: URL, calls webContents.printToPDF, then destroys
// the window in finally. Designed to be called from main.js only - the hidden
// window never shows to the user, and we never reuse it across generations
// (cheap to create, properly torn down each time).
//
// Input: opts - { BrowserWindow, sections, title, subtitle, meta, createdAt,
//                  accentColor, appState? } - BrowserWindow + app injected by main.
// Output: { ok, pdfBuffer?, html?, filename, error? }
async function generatePdf(opts) {
  if (!opts || !opts.BrowserWindow) {
    return { ok: false, error: 'BrowserWindow not provided' };
  }
  const sections = Array.isArray(opts.sections) ? opts.sections : [];
  if (!sections.length) return { ok: false, error: 'no sections provided' };

  const html = renderSectionsHtml(sections, {
    title: opts.title, subtitle: opts.subtitle, meta: opts.meta,
    createdAt: opts.createdAt || new Date(), accentColor: opts.accentColor
  });

  // Hidden window, no menu, no flash of content. show:false ensures it never
  // appears on screen even for a frame.
  const win = new opts.BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  // Closure-scoped so the `finally` always cleans up even when `tmpFiles`
  // isn't passed in by the caller. Every PDF generation writes exactly one
  // tmp .html to userData which we MUST remove or userData fills up over time.
  const tmpFiles = [];
  try {
    // Render large HTML via disk instead of a data: URL: Chromium caps data URLs
    // around 2 MB and a chat-DOCGEN body (full book summary, etc.) can exceed
    // that. Spilling to a tmp HTML file in userData avoids the silent fail.
    const tmpPath = require('path').join(
      (opts.app && opts.app.getPath && opts.app.getPath('userData')) || require('os').tmpdir(),
      'caryl-docgen-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.html'
    );
    tmpFiles.push(tmpPath);
    require('fs').writeFileSync(tmpPath, html, 'utf8');
    // Race loadFile vs a hard timeout so a hung renderer can't leak the
    // BrowserWindow. Throwing inside the loser still hits our `finally` below
    // which destroys the window.
    const LOAD_TIMEOUT_MS = 30000;
    await Promise.race([
      win.loadFile(tmpPath),
      new Promise(function (_resolve, reject) {
        setTimeout(function () { reject(new Error('docgen: loadFile timeout (' + LOAD_TIMEOUT_MS + 'ms)')); }, LOAD_TIMEOUT_MS);
      })
    ]);
    const pdfBuffer = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      // Belt-and-braces margins; @page CSS already says 16/14/18/14 mm.
      margins: { top: 0.55, bottom: 0.65, left: 0.4, right: 0.4 },
      preferCSSPageSize: true
    });
    return {
      ok: true,
      pdfBuffer: pdfBuffer,
      html: html,
      filename: safeFilename(opts.title || 'caryl-document', 'pdf')
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    // Best-effort tmp-file cleanup so userData doesn't accumulate stale HTML
    // after a crash, failed generation, or successful generation.
    try {
      tmpFiles.forEach(function (p) { try { require('fs').unlinkSync(p); } catch (_e) {} });
    } catch (_e) {}
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (_e) {}
  }
}

// Open the standard save dialog and write the buffer/string to disk. Used by
// both PDF and the other formats. Caller passes either `buffer` (for pdf) OR
// `text` (for md/html/txt). The dialog's filters are scoped per format.
async function saveDocDialog(opts) {
  // `opts` is what main.js builds: { dialog, app, format, buffer|text,
  // defaultFilename } - keeping the dialog off the module lets tests stub it.
  if (!opts || !opts.dialog || !opts.app) {
    return { ok: false, error: 'dialog and app are required' };
  }
  const format = String(opts.format || 'pdf').toLowerCase();
  const ext = (format === 'pdf') ? 'pdf' : (format === 'md' ? 'md' : format);
  const defaultName = String(opts.defaultFilename || 'caryl-document');
  const safeName = safeFilename(defaultName.replace(/\.[^.]+$/, ''), ext);
  const defaultPath = require('path').join(
    (opts.app.getPath && opts.app.getPath('documents')) || require('os').homedir(),
    safeName
  );
  const filters = filterFor(format);
  try {
    const result = await opts.dialog.showSaveDialog({
      title: 'Save Caryl document',
      defaultPath: defaultPath,
      filters: filters
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const fs = require('fs');
    let buffer;
    if (opts.buffer) {
      // Already a Buffer (PDF). Tolerate Uint8Array too.
      buffer = Buffer.isBuffer(opts.buffer) ? opts.buffer : Buffer.from(opts.buffer);
    } else if (typeof opts.text === 'string') {
      buffer = Buffer.from(opts.text, 'utf8');
    } else {
      return { ok: false, error: 'nothing to save' };
    }
    fs.writeFileSync(result.filePath, buffer);
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

function filterFor(format) {
  if (format === 'pdf') return [{ name: 'PDF', extensions: ['pdf'] }, { name: 'All Files', extensions: ['*'] }];
  if (format === 'md') return [{ name: 'Markdown', extensions: ['md', 'markdown'] }, { name: 'All Files', extensions: ['*'] }];
  if (format === 'html') return [{ name: 'HTML', extensions: ['html', 'htm'] }, { name: 'All Files', extensions: ['*'] }];
  return [{ name: 'Plain Text', extensions: ['txt'] }, { name: 'All Files', extensions: ['*'] }];
}

module.exports = {
  // pure helpers (renderer-safe)
  safeFilename: safeFilename,
  escHtml: escHtml,
  inlineMd: inlineMd,
  renderSectionsHtml: renderSectionsHtml,
  generateMarkdown: generateMarkdown,
  generateText: generateText,
  generateHtml: generateHtml,
  // Electron-side (main.js only - depends on BrowserWindow / dialog / app)
  generatePdf: generatePdf,
  saveDocDialog: saveDocDialog,
  filterFor: filterFor
};
