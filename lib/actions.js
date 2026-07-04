// Local "hands" for the cloud brain. The model decides WHAT to do (via tool calls);
// this runs it natively on the user's machine. Zero external dependencies - uses Node's
// child_process and Electron's shell only.
const { shell } = require('electron');
const { exec } = require('child_process');
const guard = require('./kernel/guard');

// Every tool here drives the GUI or a browser. When the Hybrid Automation Kernel has
// classified the current turn as PURE_LOGIC / API_NATIVE, the GUI is strictly forbidden -
// so these are refused BEFORE they can execute (no launch, no browser). This is the hard
// runtime half of the "logic/API over GUI" rule; the router flag is the soft half.
const GUI_TOOLS = new Set(['open_app', 'open_url', 'web_search']);

// Tool schema sent to the model (OpenAI-compatible function calling).
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'open_app',
      description: 'Open or launch a desktop application by name, e.g. chrome, spotify, notepad, calculator, vlc, discord.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The application name to launch.' } },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Open a website in the user\'s default browser.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The website URL, e.g. youtube.com' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for something; opens the results in the browser.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to search for.' } },
        required: ['query']
      }
    }
  }
];

function openApp(name) {
  // Sanitize hard: only letters, numbers, space, dot, underscore, hyphen. This removes
  // any shell metacharacters, so launching via the shell can't be turned into injection.
  const safe = String(name || '').replace(/[^a-zA-Z0-9 ._-]/g, '').trim();
  if (!safe) return { ok: false, summary: 'No app name was given.' };
  try {
    if (process.platform === 'win32') exec('start "" "' + safe + '"', () => {});
    else if (process.platform === 'darwin') exec('open -a "' + safe + '"', () => {});
    else exec('"' + safe + '" &', () => {});
    return { ok: true, summary: 'Opened ' + safe + '.' };
  } catch (e) {
    return { ok: false, summary: "Couldn't open " + safe + ' (' + e.message + ').' };
  }
}

function openUrl(url) {
  let u = String(url || '').trim();
  if (!u) return { ok: false, summary: 'No URL was given.' };
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    shell.openExternal(u);
    return { ok: true, summary: 'Opened ' + u };
  } catch (e) {
    return { ok: false, summary: "Couldn't open " + u + '.' };
  }
}

function webSearch(query) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, summary: 'No search query was given.' };
  const u = 'https://www.google.com/search?q=' + encodeURIComponent(q);
  shell.openExternal(u);
  return { ok: true, summary: 'Searched the web for "' + q + '".' };
}

// Dispatch a single tool call. Returns { ok, summary } - summary is shown in the
// activity log AND fed back to the model so it can confirm naturally.
async function run(name, args) {
  args = args || {};
  // Enforce the Kernel's GUI hard-block: a logic/API turn may not touch the GUI.
  if (GUI_TOOLS.has(name)) {
    const blocked = guard.isBlocked();
    if (blocked) {
      return { ok: false, summary: 'Blocked: this task is handled by logic/API, so GUI actions are disabled (' + blocked + ').' };
    }
  }
  if (name === 'open_app') return openApp(args.name || args.target || args.app);
  if (name === 'open_url') return openUrl(args.url || args.target);
  if (name === 'web_search') return webSearch(args.query || args.target || args.q);
  return { ok: false, summary: 'Unknown action: ' + name };
}

module.exports = { TOOLS, run };
