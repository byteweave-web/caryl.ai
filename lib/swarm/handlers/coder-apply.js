// lib/swarm/handlers/coder-apply.js
// ------------------------------------------------------------------
// Coder apply step. Lives in its own file so it is impossible to call
// from the swarm's normal invoke() flow - this module ONLY exports a
// single `apply(payload) → {ok, ...}` function which the main-process
// `coder:apply` IPC handler invokes. There is no handler registration
// with the SwarmRouter for apply; the router cannot dispatch into this.
// This is a defense-in-depth boundary: even if a 120B prompt trick
// somehow produced a "coder.apply" dispatch, the router would reject
// it (unknown action) and the apply gate would never run.
//
// Pre-conditions, ALL required:
//   - payload.confirmed === true  (explicit user confirmation)
//   - payload.target   ∈ ALLOWED_TARGETS
//   - payload.file     exists, resolves under the project root
// ------------------------------------------------------------------

'use strict';

const fs = require('fs');
const path = require('path');
const { ALLOWED_TARGETS } = require('./coder');

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

async function apply(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'coder_apply_not_object' };
  }
  if (payload.confirmed !== true) {
    return { ok: false, error: 'must_be_confirmed', reason: 'set confirmed:true only after the user clicked Apply in the diff modal' };
  }
  const target = String(payload.target || '');
  if (!ALLOWED_TARGETS.includes(target)) {
    return { ok: false, error: 'coder_apply_bad_target', allowed: ALLOWED_TARGETS };
  }
  const fileRel = payload.file;
  if (!fileRel || typeof fileRel !== 'string') {
    return { ok: false, error: 'coder_apply_missing_file' };
  }
  const root = targetRoot(target);
  if (!root) return { ok: false, error: 'coder_apply_unknown_target' };
  const absolute = path.resolve(root, fileRel);
  if (!absolute.startsWith(root)) {
    return { ok: false, error: 'path_out_of_whitelist', root, absolute };
  }
  if (typeof payload.new_text !== 'string') {
    return { ok: false, error: 'coder_apply_missing_new_text' };
  }
  // Allow only the documented target files. Whitelist by suffix:
  const allowBySuffix = {
    main:     ['.js', '.json', '.md'],
    renderer: ['.html', '.css', '.js', '.svg'],
    preload:  ['.js', '.json'],
    sidecar:  ['.py', '.json'],
    styles:   ['.css', '.html', '.js'],
  };
  const ext = path.extname(absolute).toLowerCase();
  if (!allowBySuffix[target].includes(ext)) {
    return { ok: false, error: 'extension_not_allowed_for_target', ext, target, allowed: allowBySuffix[target] };
  }
  try {
    let before = '';
    try { before = await fs.promises.readFile(absolute, 'utf8'); } catch (_e) { /* new file */ }
    await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
    await fs.promises.writeFile(absolute, String(payload.new_text), 'utf8');
    return { ok: true, file: absolute, target, bytes: Buffer.byteLength(String(payload.new_text), 'utf8'), previous_bytes: Buffer.byteLength(before, 'utf8') };
  } catch (e) {
    return { ok: false, error: 'coder_apply_write_threw: ' + (e && e.message ? e.message : String(e)) };
  }
}

module.exports = { apply };
