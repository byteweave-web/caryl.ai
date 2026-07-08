// lib/swarm/handlers/coder.js
// ------------------------------------------------------------------
// Coder: smart propose-only handler with a template library.
//
// The handler is split into two paths:
//   1. EXPLICIT data — caller gave us data.search/data.replace/data.new_text.
//      Use the original-text replacement path (cheap, predictable).
//   2. SPEC-ONLY — caller gave us data.spec and lets the template engine
//      pick. lib/swarm/codegen-templates.js maps (target, spec) -> template.
//
// The handler READS the target file from disk so templates don't depend
// on the renderer forwarding the original contents. If the file is
// missing AND the spec implies a NEW file (`spec.startsWith("create")`),
// we proceed with empty original_text; otherwise we return a clean
// {ok:false, error:'file_required'}.
//
// NEVER writes to disk. The actual disk write lives in
// lib/swarm/handlers/coder-apply.js, gated on `confirmed:true`.
// ------------------------------------------------------------------

'use strict';

const fs = require('fs');
const path = require('path');
const templates = require('../codegen-templates');

const ALLOWED_TARGETS = templates.TEMPLATES.length
  ? Array.from(new Set([].concat.apply([], templates.TEMPLATES.map(function (t) { return t.targets; }))))
  : ['main', 'renderer', 'preload', 'sidecar', 'styles'];

// Map logical target -> conventional file group. Used both by the apply
// gate (coder-apply.js) AND by the handler when it needs to read the
// original file from disk for the template pass.
function targetRoot(target) {
  switch (target) {
    case 'main':     return path.resolve(__dirname, '..', '..');
    case 'renderer': return path.resolve(__dirname, '..', '..', 'renderer');
    case 'preload':  return path.resolve(__dirname, '..', '..');
    case 'sidecar':  return path.resolve(__dirname, '..', '..');
    case 'styles':   return path.resolve(__dirname, '..', '..', 'renderer');
    default:         return null;
  }
}

function _renderDiff(fileRel, before, after) {
  return templates._diff(fileRel, before, after);
}

// Read file at `<root>/<fileRel>`. Returns '' on ENOENT (treated as empty
// original). Returns null if the file exists but is binary (i.e. has a
// null byte in the first 8 KiB) — templates can't help with that.
async function _readOriginal(root, fileRel) {
  if (!root || !fileRel) return '';
  const abs = path.resolve(root, fileRel);
  if (!abs.startsWith(root)) return null; // out of scope
  try {
    const buf = await fs.promises.readFile(abs);
    for (let i = 0; i < Math.min(buf.length, 8000); i++) {
      if (buf[i] === 0) return null; // binary
    }
    return buf.toString('utf8');
  } catch (_e) {
    return '';
  }
}

async function invoke(d) {
  const action = String(d.action || '');
  if (action !== 'coder.generate') {
    return { ok: false, error: 'unknown_coder_action', action };
  }
  const data = d.data || {};
  const target = data.target;
  if (!target || !ALLOWED_TARGETS.includes(target)) {
    return { ok: false, error: 'coder_target_required', allowed: ALLOWED_TARGETS };
  }
  const fileRel = typeof data.path === 'string' ? data.path : null;
  if (fileRel && typeof fileRel !== 'string') {
    return { ok: false, error: 'coder_path_must_be_string' };
  }

  const root = targetRoot(target);
  const originalText = await _readOriginal(root, fileRel);

  // ---- EXPLICIT-ESCAPE PATH --------------------------------------
  // Caller supplied data.search + data.replace, OR data.new_text. Honor
  // these verbatim; templates are bypassed. This is the path a 120B
  // model or a power user uses to force a deterministic patch.
  if (typeof data.search === 'string' && typeof data.replace === 'string' && fileRel) {
    const before = data.original_text != null ? String(data.original_text) : (originalText || data.search);
    let count = 0, idx = 0;
    while ((idx = before.indexOf(data.search, idx)) !== -1) { count += 1; idx += data.search.length; }
    if (count === 0) {
      return { ok: false, error: 'search_not_found', where: fileRel, search: data.search.slice(0, 120) };
    }
    if (count > 1) {
      return { ok: false, error: 'search_not_unique_count', where: fileRel, count, search: data.search.slice(0, 120) };
    }
    const after = before.split(data.search).join(data.replace);
    return {
      ok: true,
      agent: 'Coder', action: 'coder.generate',
      target, file: fileRel, spec: data.spec || null,
      proposed_patch: data.replace,
      diff_text: _renderDiff(fileRel, before, after),
      template_used: 'explicit_search_replace',
      notes: 'Replaced exactly one occurrence of the search string in ' + fileRel + '.',
    };
  }
  if (typeof data.new_text === 'string' && fileRel) {
    const before = data.original_text != null ? String(data.original_text) : (originalText || '');
    const after = String(data.new_text);
    return {
      ok: true,
      agent: 'Coder', action: 'coder.generate',
      target, file: fileRel, spec: data.spec || null,
      proposed_patch: after,
      diff_text: _renderDiff(fileRel, before, after),
      template_used: 'explicit_new_text',
      notes: 'Replaced entire file contents with new_text (caller pre-baked the result).',
    };
  }

  // ---- TEMPLATE PATH ---------------------------------------------
  // The caller gave us a spec; let the registry pick. Requires a file
  // path on every target except `styles` (which can be a NEW stylesheet).
  if (!fileRel) {
    return { ok: false, error: 'coder_path_required_for_template_path', allowed_targets: ALLOWED_TARGETS };
  }
  const ctx = { target, file: fileRel, original_text: originalText || '', spec: data.spec || '' };
  const built = templates.pick(ctx);
  // If a template refused (e.g. bad channel in add_ipc_handler), surface as ok:false
  // so the Critic loop reads the explicit `notes` and re-dispatches with a fix.
  if (built.refused === true) {
    return {
      ok: false, agent: 'Coder', action: 'coder.generate',
      target, file: fileRel, spec: data.spec || null,
      template_used: built.template_used || 'refused',
      notes: built.notes,
    };
  }
  return {
    ok: true,
    agent: 'Coder', action: 'coder.generate',
    target, file: fileRel, spec: data.spec || null,
    proposed_patch: built.proposed_patch,
    diff_text: built.diff_text,
    template_used: built.template_used || 'unknown',
    notes: built.notes,
  };
}

module.exports = { invoke, ALLOWED_TARGETS, targetRoot };
