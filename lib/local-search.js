// lib/local-search.js
// [OFFLINE-INTEGRATION] Keyless web search + page reading for OFFLINE mode's web_search.
//
// Ported from the old offline build's agent.py: DuckDuckGo's HTML endpoint (no API key),
// readable-text extraction, and the same hard caps on pages / page size / timeouts so a
// search always finishes quickly. The synthesis step (turning page text into a spoken
// answer) happens in main.js via the local model - this module only searches and reads.
//
// Read-only on the world: it fetches and extracts text, nothing else.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 8000;   // per page (same as agent.py's 8s)
const MAX_PAGE_BYTES = 900000;   // cap raw bytes pulled from one page
const PER_PAGE_CHARS = 2800;     // cap extracted text per page

function _unescapeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// DuckDuckGo wraps result links like //duckduckgo.com/l/?uddg=<encoded>
function _decodeDdgHref(href) {
  const h = String(href || '');
  if (h.indexOf('uddg=') !== -1) {
    try {
      const u = new URL(h.startsWith('//') ? 'https:' + h : h);
      const real = u.searchParams.get('uddg');
      if (real) return decodeURIComponent(real);
    } catch (_e) { /* fall through */ }
  }
  if (h.startsWith('//')) return 'https:' + h;
  return h;
}

// Crude but effective HTML -> readable text (mirrors agent.py's fallback extractor,
// which is what actually mattered in practice): strip non-content blocks, then tags.
function _htmlToText(html, maxChars) {
  let t = String(html || '');
  t = t.replace(/<(script|style|noscript|svg|head|nav|footer|form)[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = _unescapeHtml(t);
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.slice(0, maxChars || PER_PAGE_CHARS);
}

async function _httpGet(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      text: buf.slice(0, MAX_PAGE_BYTES).toString('utf8'),
      ctype: res.headers.get('content-type') || ''
    };
  } finally {
    clearTimeout(timer);
  }
}

// Return up to maxResults of [{title, url, snippet}] from DuckDuckGo's HTML endpoints.
async function searchWeb(query, maxResults) {
  const max = Math.max(1, Number(maxResults) || 3);
  const results = [];
  const bases = ['https://html.duckduckgo.com/html/', 'https://lite.duckduckgo.com/lite/'];
  for (const base of bases) {
    let html = '';
    try {
      const r = await _httpGet(base + '?q=' + encodeURIComponent(query));
      html = r.text;
    } catch (_e) { continue; }

    // html.duckduckgo.com layout
    let m;
    const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = linkRe.exec(html)) !== null) {
      const title = _unescapeHtml(m[2].replace(/<[^>]+>/g, '')).trim();
      results.push({ title, url: _decodeDdgHref(m[1]), snippet: '' });
    }
    // snippets (best-effort, aligned by order)
    const snips = [];
    const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = snipRe.exec(html)) !== null) {
      snips.push(_unescapeHtml(m[1].replace(/<[^>]+>/g, '')).trim());
    }
    for (let i = 0; i < snips.length && i < results.length; i++) results[i].snippet = snips[i];

    // lite.duckduckgo.com fallback layout
    if (!results.length) {
      const liteRe = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = liteRe.exec(html)) !== null) {
        const title = _unescapeHtml(m[2].replace(/<[^>]+>/g, '')).trim();
        results.push({ title, url: _decodeDdgHref(m[1]), snippet: '' });
      }
    }
    if (results.length) break;
  }

  // de-dupe by url, keep order, drop non-http junk
  const seen = new Set();
  const cleaned = [];
  for (const r of results) {
    const u = r.url || '';
    if (!u.startsWith('http') || seen.has(u)) continue;
    seen.add(u);
    cleaned.push(r);
    if (cleaned.length >= max) break;
  }
  return cleaned;
}

// Fetch a page and return readable text ('' on failure / non-HTML content).
async function fetchReadable(url, maxChars) {
  try {
    const { text, ctype } = await _httpGet(url);
    const looksHtml = ctype.indexOf('html') !== -1 || text.slice(0, 2000).toLowerCase().indexOf('<html') !== -1;
    if (!looksHtml) return '';
    return _htmlToText(text, maxChars || PER_PAGE_CHARS);
  } catch (_e) {
    return '';
  }
}

module.exports = { searchWeb, fetchReadable, _htmlToText, _decodeDdgHref, _unescapeHtml };
