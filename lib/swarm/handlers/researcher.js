// lib/swarm/handlers/researcher.js
// ------------------------------------------------------------------
// Researcher: real-time information retrieval.
// Per prompts/orchestrator-system.md §5, allowed actions are:
//   researcher.web   - DuckDuckGo search over the open web
//   researcher.docs  - DuckDuckGo search scoped to docs/dev sites
//   researcher.local - regex/code search across the user's repo
//
// Returns {ok, hits, results, note} where `note` reports partial /
// empty results instead of `{ok:false}` so the Critic retry loop
// doesn't loop forever on "no results" (which isn't a failure, it's
// the answer). Returns `{ok:false}` ONLY on actual handler-level
// errors (bad op, missing query, internal throw).
// ------------------------------------------------------------------

'use strict';

const fs = require('fs');
const path = require('path');
const { searchWeb, fetchReadable } = require('../../local-search');

const DOCS_DOMAINS = [
  'developer.mozilla.org',
  'github.com',
  'stackoverflow.com',
  'devdocs.io',
  'electronjs.org',
  'nodejs.org',
  'python.org',
  'learn.microsoft.com',
  'react.dev',
];

function _validateOp(d) {
  const op = String(d.action || '').split('.').pop();
  if (!['web', 'docs', 'local'].includes(op)) {
    return { ok: false, error: 'unknown_researcher_op', action: d.action };
  }
  return { ok: true, op };
}

// Open-web search. d.data.query (required), d.data.maxResults (default 3).
async function _web(d) {
  const query = (d && d.data && d.data.query) || '';
  const max = Math.max(1, Math.min(10, (d && d.data && d.data.maxResults) || 3));
  if (!query || typeof query !== 'string') {
    return { ok: false, error: 'researcher.web_missing_query' };
  }
  let hits = [];
  let note = '';
  try {
    hits = await searchWeb(query, max);
    if (!hits.length) note = 'no_results_from_duckduckgo';
  } catch (_e) {
    note = 'duckduckgo_unreachable';
  }
  // Optionally pull readable text from the top hit (capped, best-effort).
  const excerpts = [];
  for (let i = 0; i < Math.min(2, hits.length); i++) {
    try {
      const text = await fetchReadable(hits[i].url, 1200);
      if (text) excerpts.push({ url: hits[i].url, title: hits[i].title, excerpt: text });
    } catch (_e) { /* skip this hit */ }
  }
  return {
    ok: true,
    op: 'web',
    agent: 'Researcher',
    query,
    hits,
    excerpts,
    count: hits.length,
    note,
  };
}

// Docs-scoped search. d.data.query (required). Sites: MDN, GitHub, StackOverflow, etc.
async function _docs(d) {
  const query = (d && d.data && d.data.query) || '';
  const max = Math.max(1, Math.min(10, (d && d.data && d.data.maxResults) || 4));
  if (!query || typeof query !== 'string') {
    return { ok: false, error: 'researcher.docs_missing_query' };
  }
  let hits = [];
  let note = '';
  try {
    hits = await searchWeb(query, max * 2); // over-fetch then filter
    hits = hits.filter((h) => DOCS_DOMAINS.some((dom) => (h.url || '').indexOf(dom) !== -1));
    if (!hits.length) note = 'no_results_from_docs_sites';
    hits = hits.slice(0, max);
  } catch (_e) {
    note = 'duckduckgo_unreachable';
  }
  const excerpts = [];
  for (let i = 0; i < Math.min(2, hits.length); i++) {
    try {
      const text = await fetchReadable(hits[i].url, 1200);
      if (text) excerpts.push({ url: hits[i].url, title: hits[i].title, excerpt: text });
    } catch (_e) { /* skip */ }
  }
  return {
    ok: true,
    op: 'docs',
    agent: 'Researcher',
    query,
    hits,
    excerpts,
    count: hits.length,
    note,
  };
}

// Local repo grep across lib/, renderer/, prompts/, tests/.
// d.data.pattern (required), d.data.path (optional project-relative),
// d.data.maxResults (default 25).
async function _local(d) {
  const pattern = (d && d.data && d.data.pattern) || '';
  if (!pattern || typeof pattern !== 'string') {
    return { ok: false, error: 'researcher.local_missing_pattern' };
  }
  if (pattern.length > 400) {
    return { ok: false, error: 'researcher.local_pattern_too_long' };
  }
  let regex;
  try {
    regex = new RegExp(pattern, 'gm');
  } catch (_e) {
    return { ok: false, error: 'researcher.local_bad_regex' };
  }
  const max = Math.max(1, Math.min(50, (d && d.data && d.data.maxResults) || 25));
  const projectRoot = (d && d.data && d.data.projectRoot) || path.resolve(__dirname, '..', '..');
  const subpath = (d && d.data && d.data.path) || '.';
  const baseDir = path.resolve(projectRoot, subpath);
  if (!baseDir.startsWith(projectRoot)) {
    return { ok: false, error: 'researcher.local_path_out_of_project' };
  }
  const hits = [];
  const FAIL_HARD = 50_000; // hard cap on matched lines so a runaway pattern can't stall
  await _walk(baseDir, hits, regex, max, FAIL_HARD);
  return {
    ok: true,
    op: 'local',
    agent: 'Researcher',
    pattern,
    count: hits.length,
    hits,
    note: hits.length >= max ? 'truncated' : (hits.length ? '' : 'no_matches'),
  };
}

async function _walk(dir, hits, re, max, hardCap) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (_e) { return; }
  for (const ent of entries) {
    if (hits.length >= max || hits.length >= hardCap) return;
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await _walk(full, hits, re, max, hardCap);
      continue;
    }
    if (!ent.isFile()) continue;
    let buf;
    try {
      buf = await fs.promises.readFile(full, 'utf8');
    } catch (_e) { continue; }
    const rel = full; // absolute is fine for the renderer
    const lines = buf.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= max || hits.length >= hardCap) return;
      re.lastIndex = 0;
      if (re.test(lines[i])) {
        hits.push({ file: rel, line: i + 1, snippet: lines[i].slice(0, 160) });
      }
    }
  }
}

async function invoke(d) {
  const v = _validateOp(d);
  if (!v.ok) return v;
  try {
    if (v.op === 'web') return await _web(d);
    if (v.op === 'docs') return await _docs(d);
    if (v.op === 'local') return await _local(d);
    return { ok: false, error: 'researcher_unreachable_op' };
  } catch (e) {
    return { ok: false, error: 'researcher_threw: ' + (e && e.message ? e.message : String(e)) };
  }
}

module.exports = { invoke };
