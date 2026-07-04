// lib/kernel/router.js
// Deterministic task classifier for the Hybrid Automation Kernel.
//
// PURE: no I/O, no Electron, no state. Takes the request text plus a registry
// snapshot (an array of entry objects, as registry.all() returns) and decides which
// task, if any, handles it. A confident PURE_LOGIC/API_NATIVE match hard-blocks the GUI
// for that turn; a miss returns null so the caller falls through to the LLM tool flow.
//
// This is intentionally testable without a live desktop — it and the registry ship and
// get tested before any handler exists.

const DEFAULT_THRESHOLD = 0.5;

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Lower-cased, whitespace-collapsed text for matching.
function normalize(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Whole-word presence test for a (possibly multi-word) term.
function present(normText, term) {
  const t = String(term == null ? '' : term).toLowerCase().trim();
  if (!t) return false;
  return new RegExp('\\b' + escapeRegex(t) + '\\b').test(normText);
}

// hits -> score in (0,1): 1 hit = 0.5, 2 = 0.667, 3 = 0.75 ... saturating.
// More matched terms rank higher, and a lone required-term hit sits exactly at the
// default threshold.
function hitsToScore(hits) {
  return hits > 0 ? 1 - 1 / (1 + hits) : 0;
}

// Score one matcher against normalized text -> { ok, score, hits }.
function scoreMatcher(normText, matcher) {
  if (!matcher || typeof matcher !== 'object') return { ok: false, score: 0, hits: 0 };

  if (matcher.type === 'keywords') {
    const all = Array.isArray(matcher.all) ? matcher.all : [];
    const any = Array.isArray(matcher.any) ? matcher.any : [];
    for (const t of all) if (!present(normText, t)) return { ok: false, score: 0, hits: 0 };
    const anyHits = any.filter((t) => present(normText, t)).length;
    // A matcher made only of `any` terms needs at least one hit to count.
    if (all.length === 0 && any.length > 0 && anyHits === 0) return { ok: false, score: 0, hits: 0 };
    if (all.length === 0 && any.length === 0) return { ok: false, score: 0, hits: 0 };
    const hits = all.length + anyHits;
    return { ok: true, score: hitsToScore(hits), hits };
  }

  if (matcher.type === 'regex') {
    let re;
    try { re = new RegExp(matcher.pattern, matcher.flags || 'i'); }
    catch (_e) { return { ok: false, score: 0, hits: 0 }; }
    const match = re.exec(normText);
    if (!match) return { ok: false, score: 0, hits: 0 };
    const groups = match.slice(1).filter((g) => g !== undefined).length;
    const hits = 1 + groups;
    return { ok: true, score: hitsToScore(hits), hits };
  }

  return { ok: false, score: 0, hits: 0 };
}

// Best matcher wins for an entry -> { score, hits }.
function scoreEntry(normText, entry) {
  const matchers = (entry && Array.isArray(entry.matchers)) ? entry.matchers : [];
  let best = { score: 0, hits: 0 };
  for (const m of matchers) {
    const s = scoreMatcher(normText, m);
    if (s.ok && s.score > best.score) best = { score: s.score, hits: s.hits };
  }
  return best;
}

// Whitespace-collapsed text with ORIGINAL case, used for param extraction so values
// keep their casing ("Paris", not "paris").
function normalizeKeepCase(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

// "after:in|for" -> the text following the earliest of those keywords.
function extractAfter(text, keysStr) {
  const keys = String(keysStr).split('|').map((s) => s.trim()).filter(Boolean);
  const lower = text.toLowerCase();
  let bestIdx = -1, bestEnd = -1;
  for (const k of keys) {
    const mm = new RegExp('\\b' + escapeRegex(k.toLowerCase()) + '\\b').exec(lower);
    if (mm && (bestIdx === -1 || mm.index < bestIdx)) { bestIdx = mm.index; bestEnd = mm.index + mm[0].length; }
  }
  if (bestIdx === -1) return null;
  const val = text.slice(bestEnd).trim();
  return val || null;
}

// "regex:(...)" -> capture group 1 (or the whole match if no group).
function extractRegex(text, pattern) {
  let re;
  try { re = new RegExp(pattern, 'i'); } catch (_e) { return null; }
  const mm = re.exec(text);
  if (!mm) return null;
  const v = mm[1] !== undefined ? mm[1] : mm[0];
  return (v && v.trim()) || null;
}

// Pull declared params from the request. Returns { values, needs } where needs lists
// required params that could not be filled (so the caller can ask once).
function extractParams(text, entry) {
  const values = {};
  const needs = [];
  const params = (entry && Array.isArray(entry.params)) ? entry.params : [];
  for (const p of params) {
    let v = null;
    const ex = p.extractor;
    if (typeof ex === 'string') {
      if (ex.startsWith('after:')) v = extractAfter(text, ex.slice(6));
      else if (ex.startsWith('regex:')) v = extractRegex(text, ex.slice(6));
    }
    values[p.name] = v;
    if (p.required && (v === null || v === '')) needs.push(p.name);
  }
  return { values, needs };
}

// PURE_LOGIC and API_NATIVE tasks are strictly forbidden from touching the GUI.
function guiForbidden(cls) {
  return cls === 'PURE_LOGIC' || cls === 'API_NATIVE';
}

// Is candidate a better match than the current best?
// Order: higher score, then higher successCount, then higher hits (more specific).
function isBetter(cand, best) {
  if (cand.score !== best.score) return cand.score > best.score;
  const cs = (cand.entry && cand.entry.successCount) || 0;
  const bs = (best.entry && best.entry.successCount) || 0;
  if (cs !== bs) return cs > bs;
  return cand.hits > best.hits;
}

// classify(text, entries, opts?) -> Match | null
// Match = { entry, class, params, needs, confidence, guiBlocked }
function classify(text, entries, opts) {
  const threshold = (opts && typeof opts.threshold === 'number') ? opts.threshold : DEFAULT_THRESHOLD;
  const list = Array.isArray(entries) ? entries : [];
  const normText = normalize(text);
  if (!normText) return null;

  let best = null; // { entry, score, hits }
  for (const entry of list) {
    const s = scoreEntry(normText, entry);
    if (s.score < threshold) continue;
    const cand = { entry, score: s.score, hits: s.hits };
    if (!best || isBetter(cand, best)) best = cand;
  }
  if (!best) return null;

  const { values, needs } = extractParams(normalizeKeepCase(text), best.entry);
  return {
    entry: best.entry,
    class: best.entry.class,
    params: values,
    needs,
    confidence: best.score,
    guiBlocked: guiForbidden(best.entry.class)
  };
}

module.exports = {
  classify, scoreMatcher, scoreEntry, extractParams, guiForbidden,
  normalize, normalizeKeepCase, present, DEFAULT_THRESHOLD
};
