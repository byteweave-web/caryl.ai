// lib/kernel/registry.js
// TaskRegistry for the Hybrid Automation Kernel: a library of classified tasks the router
// matches against. Built-in entries are registered in code at startup; learned entries
// (from the Growth Loop) round-trip to a JSON file.
//
// Testability: like lib/migrate.js, the file path is INJECTED (opts.filePath) rather than
// read from Electron's `app`, so this module never requires Electron and runs under plain
// `node` for tests. main.js passes path.join(app.getPath('userData'), 'task-registry.json').

const fs = require('fs');
const path = require('path');

const CLASSES = new Set(['PURE_LOGIC', 'API_NATIVE', 'HYBRID_UIA']);

function nowISO() { return new Date().toISOString(); }

// Pure structural validation. Returns an array of error strings ([] === valid).
function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') return ['entry must be an object'];
  const errs = [];
  if (typeof entry.id !== 'string' || !entry.id.trim()) errs.push('id is required');
  if (!CLASSES.has(entry.class)) errs.push('class must be PURE_LOGIC|API_NATIVE|HYBRID_UIA');
  if (typeof entry.handler !== 'string' || !entry.handler.trim()) errs.push('handler is required');
  if (entry.matchers !== undefined && !Array.isArray(entry.matchers)) errs.push('matchers must be an array');
  if (entry.params !== undefined && !Array.isArray(entry.params)) errs.push('params must be an array');
  if (Array.isArray(entry.matchers)) {
    for (const m of entry.matchers) {
      if (!m || typeof m !== 'object' || (m.type !== 'keywords' && m.type !== 'regex')) {
        errs.push('each matcher.type must be keywords|regex'); break;
      }
      if (m.type === 'regex' && typeof m.pattern !== 'string') { errs.push('regex matcher needs a string pattern'); break; }
    }
  }
  return errs;
}

// Produce the stored shape, deriving trusted fields from the entry's class.
// gui_forbidden is ALWAYS derived here (never trusted from disk) so a tampered file
// cannot unblock the GUI for a logic/API task.
function normalizeEntry(entry, source) {
  const cls = entry.class;
  return Object.assign(
    { title: entry.id, matchers: [], params: [] },
    entry,
    {
      source: source || entry.source || 'learned',
      gui_forbidden: cls === 'PURE_LOGIC' || cls === 'API_NATIVE',
      created: entry.created || nowISO(),
      lastUsed: entry.lastUsed || null,
      useCount: entry.useCount || 0,
      successCount: entry.successCount || 0
    }
  );
}

// createRegistry({ filePath?, builtins?, logger? }) -> registry instance
function createRegistry(opts) {
  opts = opts || {};
  const filePath = opts.filePath || null;
  const logger = (typeof opts.logger === 'function') ? opts.logger : function () {};
  const map = new Map();
  const quarantined = []; // { entry, errors } for learned entries that failed to load

  function register(entry, source) {
    const errs = validateEntry(entry);
    if (errs.length) throw new Error('invalid task entry ' + ((entry && entry.id) || '?') + ': ' + errs.join('; '));
    const norm = normalizeEntry(entry, source);
    map.set(norm.id, norm);
    return norm;
  }

  function all() { return Array.from(map.values()); }
  function byId(id) { return map.get(id) || null; }
  function byClass(cls) { return all().filter((e) => e.class === cls); }

  // Load learned entries from disk. Degrades gracefully: a missing file is normal, a
  // corrupt file leaves the built-ins intact, and a single bad entry is quarantined
  // (skipped + recorded) rather than aborting the whole load.
  function load() {
    if (!filePath) return;
    let raw;
    try { raw = fs.readFileSync(filePath, 'utf8'); }
    catch (_e) { return; } // no file yet -> nothing to load
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (_e) { logger('warn', 'task-registry.json is corrupt; ignoring learned entries'); return; }
    if (!Array.isArray(parsed)) { logger('warn', 'task-registry.json is not an array; ignoring'); return; }
    for (const entry of parsed) {
      const errs = validateEntry(entry);
      if (errs.length) { quarantined.push({ entry, errors: errs }); logger('warn', 'quarantined learned entry ' + ((entry && entry.id) || '?')); continue; }
      register(entry, 'learned');
    }
  }

  // Persist ONLY learned entries; built-ins live in code and are never written.
  function save() {
    if (!filePath) return;
    const learned = all().filter((e) => e.source === 'learned');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(learned, null, 2));
  }

  // Add a learned recipe (from the Growth Loop) and persist. Throws on a malformed entry.
  function record(entry) {
    const norm = register(entry, 'learned');
    save();
    return norm;
  }

  // Bump usage counters after a run. success:true also bumps successCount (used for
  // the router's tie-break). Learned counters are persisted; built-in counters are
  // in-memory only for the session.
  function touch(id, result) {
    const e = map.get(id);
    if (!e) return null;
    e.useCount = (e.useCount || 0) + 1;
    e.lastUsed = nowISO();
    if (result && result.success) e.successCount = (e.successCount || 0) + 1;
    if (e.source === 'learned') { try { save(); } catch (_e) { /* non-fatal */ } }
    return e;
  }

  // Built-ins are developer-authored: a malformed one throws immediately. Learned
  // entries load afterward; ids are namespaced (e.g. "weather.current" vs "wa.send")
  // so built-ins and learned recipes don't collide.
  for (const b of (opts.builtins || [])) register(b, 'builtin');
  if (filePath) load();

  return { register, all, byId, byClass, record, touch, load, save, quarantined, filePath };
}

module.exports = { createRegistry, validateEntry, normalizeEntry };
