# Caryl.ai Foundation & OS-Aware Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename BRAIN.AI to Caryl.ai with automatic data migration, replace the global online/offline mode with per-capability hybrid engine routing (chat/vision/stt/tts), add a full in-app download manager, Win10/Win11-aware styling, a first-launch onboarding wizard, fix bubble-position persistence, and cut idle RAM.

**Architecture:** Pure-function modules (`lib/engines.js`, `lib/migrate.js`) testable with plain node; `main.js` keeps its existing helper-funnel pattern (`isOffline`/`chatCfg`/`visionCfg`) but re-routes those helpers through the new engines contract so feature code paths don't change. Renderer stays vanilla HTML/JS polled via the existing `bridge` preload.

**Tech Stack:** Electron 43, plain Node (CommonJS), vanilla JS renderer, Python sidecar (Flask), Ollama, openWakeWord ONNX, Piper TTS, faster-whisper.

## Global Constraints

- Installer/repo stays **code-only**: never bundle models, voices, ONNX files, or Ollama.
- Old `%APPDATA%/BRAIN.AI` (and dev `%APPDATA%/brain-ai`) data is **never modified or deleted**.
- No new npm dependencies. No test framework — tests are plain `node tests/<file>.js` scripts using `assert`.
- All user-visible strings say **Caryl.ai** / the user's chosen display name (default **Caryl**); internal variable names are NOT mass-renamed.
- Every failure path is non-fatal: log + fallback (fresh defaults / online engine / solid styling), never crash boot.
- Existing online-mode behavior must remain byte-for-byte identical when all four engines are `'online'`.
- Windows 10 is a supported platform: no acrylic there, solid fallbacks everywhere.
- Commit after every task (small, revertible commits).

## File Structure

| File | Role |
|---|---|
| `lib/engines.js` (new) | Pure routing contract: capability → online/offline + readiness |
| `lib/migrate.js` (new) | One-time BRAIN.AI → Caryl.ai userData copy |
| `lib/downloads.js` (new) | Asset registry: install-state + download orchestration |
| `tests/test-engines.js`, `tests/test-migrate.js` (new) | Plain-node tests |
| `renderer/onboarding.html` (new) | First-launch wizard (single self-contained file) |
| `lib/config.js` | New defaults (`engines`, `osVariant`, `onboarded`, `wakeWordModel`) |
| `main.js` | Migration hook, engine call-site rerouting, OS detect, bubble fix, DevTools gate, downloads IPC, onboarding IPC, multi-wake-word |
| `preload.js` | New bridge methods |
| `renderer/index.html` | Engines & Models panel (replaces AI Mode card), redo-setup button, wake-word model pass-through |
| `renderer/wakeword.js` | Parameterized wake-word model |
| `renderer/overlay.html`, `renderer/mini-overlay.html` | `data-os="win10"` solid fallback CSS |
| `automation.py` | Whisper idle-unload + `/stt_status` + `/stt_warm` |
| `package.json` | Rename, `productName` at top level, drop dead deps |

---

### Task 1: `lib/engines.js` — pure routing contract

**Files:**
- Create: `lib/engines.js`
- Test: `tests/test-engines.js`
- Modify: `package.json` (add `"test"` script)

**Interfaces:**
- Consumes: nothing (pure functions over a plain config object).
- Produces (used by Tasks 4, 9, 10, 11):
  - `CAPABILITIES` = `['chat','vision','stt','tts']`
  - `deriveFromLegacy(cfg)` → `{chat,vision,stt,tts}` each `'online'|'offline'`
  - `normalizeEngines(cfg)` → `{ engines, changed:boolean }` (valid engines object; `changed` true when cfg.engines was absent/invalid)
  - `resolveEngine(cfg, capability)` → `'online'|'offline'`
  - `engineReady(cfg, capability, ctx)` → `{ ready:boolean, reason:string }` where `ctx = { ollamaUp, localVisionModel, piperConfigured }`

- [ ] **Step 1: Write the failing test**

```js
// tests/test-engines.js
const assert = require('assert');
const eng = require('../lib/engines');

// deriveFromLegacy: pure online defaults
let e = eng.deriveFromLegacy({});
assert.deepStrictEqual(e, { chat: 'online', vision: 'online', stt: 'online', tts: 'online' });

// legacy offline mode forces chat/vision/stt offline
e = eng.deriveFromLegacy({ mode: 'offline' });
assert.deepStrictEqual(e, { chat: 'offline', vision: 'offline', stt: 'offline', tts: 'online' });

// individual legacy flags
assert.strictEqual(eng.deriveFromLegacy({ useLocalVision: true }).vision, 'offline');
assert.strictEqual(eng.deriveFromLegacy({ useLocalVision: true }).chat, 'online');
assert.strictEqual(eng.deriveFromLegacy({ useLocalStt: true }).stt, 'offline');
assert.strictEqual(eng.deriveFromLegacy({ ttsEngine: 'piper' }).tts, 'offline');

// normalizeEngines: derives when absent, keeps valid, repairs partial
let n = eng.normalizeEngines({ mode: 'offline' });
assert.strictEqual(n.changed, true);
assert.strictEqual(n.engines.chat, 'offline');
n = eng.normalizeEngines({ engines: { chat: 'offline', vision: 'online', stt: 'online', tts: 'online' } });
assert.strictEqual(n.changed, false);
n = eng.normalizeEngines({ engines: { chat: 'bogus' }, useLocalStt: true });
assert.strictEqual(n.changed, true);
assert.strictEqual(n.engines.stt, 'offline'); // repaired from legacy flags

// resolveEngine: reads engines first, falls back to legacy derivation
assert.strictEqual(eng.resolveEngine({ engines: { chat: 'offline', vision: 'online', stt: 'online', tts: 'online' } }, 'chat'), 'offline');
assert.strictEqual(eng.resolveEngine({ mode: 'offline' }, 'chat'), 'offline');
assert.strictEqual(eng.resolveEngine({}, 'vision'), 'online');
assert.strictEqual(eng.resolveEngine({}, 'nonsense'), 'online'); // unknown capability -> online

// engineReady
const ctxUp = { ollamaUp: true, localVisionModel: 'moondream', piperConfigured: true };
const ctxDown = { ollamaUp: false, localVisionModel: '', piperConfigured: false };
assert.strictEqual(eng.engineReady({ engines: { chat: 'online', vision: 'online', stt: 'online', tts: 'online' }, apiKey: 'k' }, 'chat', ctxDown).ready, true);
assert.strictEqual(eng.engineReady({ engines: { chat: 'online', vision: 'online', stt: 'online', tts: 'online' } }, 'chat', ctxDown).ready, false); // no api key
assert.strictEqual(eng.engineReady({ engines: { chat: 'offline', vision: 'online', stt: 'online', tts: 'online' } }, 'chat', ctxUp).ready, true);
assert.strictEqual(eng.engineReady({ engines: { chat: 'offline', vision: 'online', stt: 'online', tts: 'online' } }, 'chat', ctxDown).ready, false);
assert.strictEqual(eng.engineReady({ engines: { chat: 'online', vision: 'offline', stt: 'online', tts: 'online' } }, 'vision', ctxUp).ready, true);
assert.strictEqual(eng.engineReady({ engines: { chat: 'online', vision: 'offline', stt: 'online', tts: 'online' } }, 'vision', ctxDown).ready, false);
assert.strictEqual(eng.engineReady({ engines: { chat: 'online', vision: 'online', stt: 'online', tts: 'offline' } }, 'tts', ctxDown).ready, false);
assert.strictEqual(eng.engineReady({ engines: { chat: 'online', vision: 'online', stt: 'online', tts: 'offline' } }, 'tts', ctxUp).ready, true);

console.log('test-engines: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-engines.js`
Expected: FAIL with `Cannot find module '../lib/engines'`

- [ ] **Step 3: Write the implementation**

```js
// lib/engines.js
// Per-capability hybrid engine routing: chat / vision / stt / tts each resolve to
// 'online' (cloud API) or 'offline' (local model) independently. Pure functions over a
// plain config object so this file is testable with node alone (no Electron import).
// main.js is the only consumer; it wraps these with its live config + ollama state.

const CAPABILITIES = ['chat', 'vision', 'stt', 'tts'];

// Map the pre-Caryl flags (mode / useLocalVision / useLocalStt / ttsEngine) onto the
// engines object, exactly preserving the old semantics. Used once at migration time and
// as the fallback for configs that predate `engines`.
function deriveFromLegacy(cfg) {
  cfg = cfg || {};
  const offline = (cfg.mode || 'online') === 'offline';
  return {
    chat: offline ? 'offline' : 'online',
    vision: (offline || cfg.useLocalVision === true) ? 'offline' : 'online',
    stt: (offline || cfg.useLocalStt === true) ? 'offline' : 'online',
    tts: cfg.ttsEngine === 'piper' ? 'offline' : 'online'
  };
}

function isValidEngines(engines) {
  return !!engines && CAPABILITIES.every((c) => engines[c] === 'online' || engines[c] === 'offline');
}

// Returns a guaranteed-valid engines object. changed=true means the caller should persist it.
function normalizeEngines(cfg) {
  cfg = cfg || {};
  if (isValidEngines(cfg.engines)) return { engines: cfg.engines, changed: false };
  return { engines: deriveFromLegacy(cfg), changed: true };
}

function resolveEngine(cfg, capability) {
  const { engines } = normalizeEngines(cfg);
  return engines[capability] === 'offline' ? 'offline' : 'online';
}

// Synchronous readiness check. ctx carries the live facts only main.js knows:
//   ollamaUp (bool), localVisionModel (string|''), piperConfigured (bool)
// STT offline readiness can't be known synchronously (sidecar probe is async), so it
// reports ready:true and the runtime path keeps its existing graceful fallback.
function engineReady(cfg, capability, ctx) {
  cfg = cfg || {}; ctx = ctx || {};
  const mode = resolveEngine(cfg, capability);
  if (mode === 'online') {
    if (capability === 'tts') return { ready: true, reason: '' }; // browser voice always exists
    return cfg.apiKey ? { ready: true, reason: '' } : { ready: false, reason: 'No API key saved (Settings → AI Engine).' };
  }
  // offline paths
  if (capability === 'chat') {
    return ctx.ollamaUp ? { ready: true, reason: '' } : { ready: false, reason: 'Ollama isn’t running.' };
  }
  if (capability === 'vision') {
    if (!ctx.ollamaUp) return { ready: false, reason: 'Ollama isn’t running.' };
    if (!ctx.localVisionModel) return { ready: false, reason: 'No local vision model installed.' };
    return { ready: true, reason: '' };
  }
  if (capability === 'tts') {
    return ctx.piperConfigured ? { ready: true, reason: '' } : { ready: false, reason: 'No Piper voice installed.' };
  }
  return { ready: true, reason: '' }; // stt (see note above) and unknowns
}

module.exports = { CAPABILITIES, deriveFromLegacy, normalizeEngines, resolveEngine, engineReady };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-engines.js`
Expected: `test-engines: all assertions passed`

- [ ] **Step 5: Add npm test script**

In `package.json` `"scripts"`, add:

```json
"test": "node tests/test-engines.js && node tests/test-migrate.js"
```

(test-migrate.js arrives in Task 2; until then run the engines file directly.)

- [ ] **Step 6: Commit**

```bash
git add lib/engines.js tests/test-engines.js package.json
git commit -m "feat: add per-capability engine routing contract (lib/engines.js)"
```

---

### Task 2: `lib/migrate.js` — one-time userData migration

**Files:**
- Create: `lib/migrate.js`
- Test: `tests/test-migrate.js`

**Interfaces:**
- Produces (used by Task 3):
  - `migrateUserData(newDir, legacyDirs)` → `{ migrated:boolean, from?:string, reason?:string }` — pure-ish (fs only, no Electron)
  - `run(app)` → same shape; computes `newDir = app.getPath('userData')` and legacy candidates `%APPDATA%/BRAIN.AI` and `%APPDATA%/brain-ai` (dev runs used the package `name`, packaged used `productName` — both must be checked, newest `settings.json` wins).

- [ ] **Step 1: Write the failing test**

```js
// tests/test-migrate.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateUserData } = require('../lib/migrate');

function tmp(name) {
  const p = path.join(os.tmpdir(), 'caryl-migrate-test', name + '-' + Date.now());
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// 1. no legacy dir -> nothing to do
let newDir = tmp('new1');
let r = migrateUserData(newDir, [path.join(os.tmpdir(), 'does-not-exist-xyz')]);
assert.strictEqual(r.migrated, false);
assert.strictEqual(r.reason, 'no-legacy');

// 2. legacy present, new empty -> copies everything + stamps migratedFrom
let legacy = tmp('legacy2');
fs.writeFileSync(path.join(legacy, 'settings.json'), JSON.stringify({ apiKey: 'k123', mode: 'offline' }));
fs.mkdirSync(path.join(legacy, 'openwakeword'), { recursive: true });
fs.writeFileSync(path.join(legacy, 'openwakeword', 'model.onnx'), 'bytes');
newDir = tmp('new2');
r = migrateUserData(newDir, [legacy]);
assert.strictEqual(r.migrated, true);
assert.strictEqual(r.from, legacy);
const moved = JSON.parse(fs.readFileSync(path.join(newDir, 'settings.json'), 'utf8'));
assert.strictEqual(moved.apiKey, 'k123');
assert.strictEqual(typeof moved.migratedFrom, 'string');
assert.strictEqual(fs.readFileSync(path.join(newDir, 'openwakeword', 'model.onnx'), 'utf8'), 'bytes');
// legacy untouched
assert.ok(fs.existsSync(path.join(legacy, 'settings.json')));
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(legacy, 'settings.json'), 'utf8')).migratedFrom, undefined);

// 3. new dir already has settings.json -> never overwrites (idempotent)
r = migrateUserData(newDir, [legacy]);
assert.strictEqual(r.migrated, false);
assert.strictEqual(r.reason, 'already-present');

// 4. two legacy candidates -> newest settings.json wins
const oldA = tmp('legacyA'); const oldB = tmp('legacyB');
fs.writeFileSync(path.join(oldA, 'settings.json'), JSON.stringify({ tag: 'A' }));
fs.writeFileSync(path.join(oldB, 'settings.json'), JSON.stringify({ tag: 'B' }));
const past = new Date(Date.now() - 86400000);
fs.utimesSync(path.join(oldA, 'settings.json'), past, past);
newDir = tmp('new4');
r = migrateUserData(newDir, [oldA, oldB]);
assert.strictEqual(r.migrated, true);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(newDir, 'settings.json'), 'utf8')).tag, 'B');

console.log('test-migrate: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-migrate.js`
Expected: FAIL with `Cannot find module '../lib/migrate'`

- [ ] **Step 3: Write the implementation**

```js
// lib/migrate.js
// One-time BRAIN.AI -> Caryl.ai userData migration. Copies the old data directory into
// the new one on the first Caryl boot; the old directory is NEVER modified or deleted
// (it is the user's rollback). Fully non-fatal: any failure logs and the app boots fresh.
const fs = require('fs');
const path = require('path');

function hasSettings(dir) {
  try { return fs.statSync(path.join(dir, 'settings.json')).isFile(); } catch (_e) { return false; }
}

function settingsMtime(dir) {
  try { return fs.statSync(path.join(dir, 'settings.json')).mtimeMs; } catch (_e) { return 0; }
}

// newDir: the Caryl.ai userData path. legacyDirs: candidate old dirs, any order.
function migrateUserData(newDir, legacyDirs) {
  try {
    if (hasSettings(newDir)) return { migrated: false, reason: 'already-present' };
    const candidates = (legacyDirs || []).filter(hasSettings);
    if (!candidates.length) return { migrated: false, reason: 'no-legacy' };
    candidates.sort((a, b) => settingsMtime(b) - settingsMtime(a)); // newest settings.json wins
    const from = candidates[0];
    fs.mkdirSync(newDir, { recursive: true });
    // force:false + errorOnExist:false -> existing files in newDir are never overwritten
    fs.cpSync(from, newDir, { recursive: true, force: false, errorOnExist: false });
    // Stamp the copy (never the original) so we can show "your data came along" once.
    const sf = path.join(newDir, 'settings.json');
    const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
    s.migratedFrom = path.basename(from) + ' @ ' + new Date().toISOString();
    fs.writeFileSync(sf, JSON.stringify(s, null, 2));
    return { migrated: true, from };
  } catch (e) {
    return { migrated: false, reason: 'error: ' + ((e && e.message) || String(e)) };
  }
}

// Electron entry point. Must run BEFORE the first config.get()/load() so the copied
// settings are what config reads. app.getPath works pre-ready.
function run(app) {
  const newDir = app.getPath('userData');
  const appData = app.getPath('appData');
  const legacy = [path.join(appData, 'BRAIN.AI'), path.join(appData, 'brain-ai')]
    .filter((d) => path.resolve(d) !== path.resolve(newDir)); // safety if names ever collide
  const r = migrateUserData(newDir, legacy);
  if (r.migrated) console.log('[migrate] copied legacy data from', r.from, '->', newDir);
  else if (r.reason && r.reason.indexOf('error') === 0) console.warn('[migrate]', r.reason);
  return r;
}

module.exports = { migrateUserData, run };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/test-migrate.js && node tests/test-engines.js`
Expected: both print `... all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add lib/migrate.js tests/test-migrate.js
git commit -m "feat: add one-time BRAIN.AI->Caryl.ai userData migration (lib/migrate.js)"
```

---

### Task 3: Rename to Caryl.ai + wire migration

**Files:**
- Modify: `package.json`, `main.js`, `lib/config.js`, `renderer/index.html`, `renderer/overlay.html`, `renderer/mini-overlay.html`, `README.md`, `INSTRUCTIONS.md`

**Interfaces:**
- Consumes: `require('./lib/migrate').run(app)` from Task 2.
- Produces: `app.getPath('userData')` now resolves to `%APPDATA%/Caryl.ai`; config default `assistantName: 'Caryl'`.

- [ ] **Step 1: package.json identity**

Change these fields (leave everything else):

```json
"name": "caryl-ai",
"productName": "Caryl.ai",
"description": "Caryl.ai - a fast, lightweight desktop AI companion (hybrid cloud/local).",
```

and in the `"build"` block:

```json
"appId": "com.farouk.caryl",
"productName": "Caryl.ai",
```

and `"portable": { "artifactName": "Caryl.ai-${version}.${ext}" }`.

**Note:** top-level `productName` is what makes dev (`npm start`) and packaged builds agree on `%APPDATA%/Caryl.ai` for `userData`.

- [ ] **Step 2: Wire migration at the very top of main.js**

Immediately after the single-instance lock block (after line ~46, BEFORE `require('./lib/config')` executes its first `get()` — i.e. before line 51's require group is *used*), insert:

```js
// One-time data migration from the BRAIN.AI era. Must run before the first config read.
require('./lib/migrate').run(app);
```

- [ ] **Step 3: String sweep**

Run: `grep -n "BRAIN" main.js lib/config.js renderer/index.html renderer/overlay.html renderer/mini-overlay.html preload.js | grep -iv "brainimg"` and update every **user-visible** occurrence:
- `main.js`: window `title: 'BRAIN.AI'` → `'Caryl.ai'`; media dialog `title: 'BRAIN.AI'` / `message: 'Allow BRAIN to use...'` → `'Caryl.ai'` / `'Allow Caryl to use...'`; STT error strings mentioning "restart BRAIN" → "restart Caryl"; `assistant_name: cfg.assistantName || 'BRAIN'` → `|| 'Caryl'`.
- `lib/config.js` DEFAULTS `systemPrompt`: `'You are Caryl, a sharp, friendly desktop AI companion. Be concise, warm, and genuinely helpful. Answer directly and admit when you are unsure.'`
- `renderer/*.html`: page `<title>`, header wordmarks, any "BRAIN" copy → "Caryl.ai"/"Caryl".
- `README.md` / `INSTRUCTIONS.md`: title lines + the `%APPDATA%/BRAIN.AI` data-location sentence (now `%APPDATA%/Caryl.ai`, migrated automatically).
- Leave alone: `brainimg://` scheme, code comments, variable names, `com.farouk.brainai` history.

- [ ] **Step 4: Verify by launch**

Run: `npm start`
Expected: app opens titled **Caryl.ai**; console shows `[migrate] copied legacy data from ... -> ...Caryl.ai` on the FIRST launch only; your existing chats/settings/API key are present; `%APPDATA%/brain-ai` (or `BRAIN.AI`) still intact on disk. Second launch: no migrate log line.

- [ ] **Step 5: Commit**

```bash
git add package.json main.js lib/config.js renderer/ README.md INSTRUCTIONS.md
git commit -m "feat: rename to Caryl.ai with automatic legacy data migration"
```

---

### Task 4: Re-route main.js through the engines contract

**Files:**
- Modify: `main.js` (mode-resolution block ~60–166, `speak()` ~368, STT handler ~2121, `ui:status` ~2928, `config:set` ~2896, `app.whenReady` ~2881), `lib/config.js`

**Interfaces:**
- Consumes: `engines.normalizeEngines`, `engines.resolveEngine`, `engines.deriveFromLegacy`, `engines.engineReady` (Task 1).
- Produces (used by Tasks 9–11):
  - main.js helper `engineOf(cap)` → `'online'|'offline'`
  - `ui:status` gains `engines: {chat,vision,stt,tts}` and keeps legacy fields derived from it
  - `config:set` accepts an `engines` patch and translates legacy patches (`mode`, `useLocalVision`, `useLocalStt`, `ttsEngine`) into `engines`.

- [ ] **Step 1: Add defaults in lib/config.js**

In `DEFAULTS`, add (values must match `deriveFromLegacy({})`):

```js
engines: { chat: 'online', vision: 'online', stt: 'online', tts: 'online' },
onboarded: false,
osVariant: '',                             // '' = not yet detected; set at boot (Task 5)
wakeWordModel: 'hey_jarvis_v0.1.onnx',     // which openWakeWord classifier to run (Task 8)
```

- [ ] **Step 2: Wire the contract into main.js mode-resolution block**

After `const localSearch = require('./lib/local-search');` add:

```js
const enginesLib = require('./lib/engines');

// Ensure cfg.engines exists (one-time derivation from the pre-Caryl flags).
{
  const norm = enginesLib.normalizeEngines(config.get());
  if (norm.changed) config.set({ engines: norm.engines });
}

// The single question every feature path asks: which engine serves this capability NOW?
function engineOf(capability) {
  return enginesLib.resolveEngine(config.get(), capability);
}
```

Replace the body of `isOffline` (keep the signature — dozens of call sites pass cfg):

```js
function isOffline(cfg) {
  return enginesLib.resolveEngine(cfg || config.get(), 'chat') === 'offline';
}
```

Replace `visionCfg` (vision is now independent of chat mode; same fallback semantics as the old online+useLocalVision path — local when possible, cloud otherwise so requests always answer):

```js
function visionCfg(cfg) {
  cfg = cfg || config.get();
  const lv = localVisionModel(cfg);
  if (enginesLib.resolveEngine(cfg, 'vision') === 'offline') {
    if (ollama.isUp() && lv) return { baseUrl: ollama.BASE_V1, apiKey: 'ollama', model: lv };
    if (isOffline(cfg)) {
      // fully-local setup: still answer via the chat model rather than silently failing
      return { baseUrl: ollama.BASE_V1, apiKey: 'ollama', model: lv || (cfg.offlineModel || DEFAULT_OFFLINE_MODEL) };
    }
    // hybrid (chat online, vision offline but not ready): visible cloud fallback, never dead air
    console.warn('[engines] vision=offline but not ready (' + enginesLib.engineReady(cfg, 'vision', { ollamaUp: ollama.isUp(), localVisionModel: lv }).reason + ') - using cloud vision');
  }
  const VISION = { groq: cfg.visionModel || 'qwen/qwen3.6-27b', gemini: 'gemini-2.5-flash', openai: 'gpt-4o-mini' };
  return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: VISION[cfg.provider] || cfg.visionModel || cfg.model };
}
```

- [ ] **Step 3: Re-route STT and TTS**

STT handler (~line 2121): change `if (isOffline(cfg) || cfg.useLocalStt) {` → `if (enginesLib.resolveEngine(cfg, 'stt') === 'offline') {`

`speak()` (~line 374): change `if (cfg.ttsEngine === 'piper' && cfg.piperPath && cfg.piperModel) {` → `if (enginesLib.resolveEngine(cfg, 'tts') === 'offline' && cfg.piperPath && cfg.piperModel) {`

- [ ] **Step 4: Boot + config:set side effects**

`app.whenReady` (~2881): `if (cfg0.mode === 'offline' || cfg0.useLocalVision) {` → `if (enginesLib.resolveEngine(cfg0, 'chat') === 'offline' || enginesLib.resolveEngine(cfg0, 'vision') === 'offline') {`

`config:set` handler (~2896): after `const r = config.set(patch || {});` add legacy-patch translation + engine boot triggers:

```js
  // Translate legacy mode flags (old settings UI / old renderer versions) into engines,
  // and keep legacy flags in sync when engines is patched directly - both directions,
  // so either vocabulary keeps working during and after the transition.
  if (patch && !patch.engines && (('mode' in patch) || ('useLocalVision' in patch) || ('useLocalStt' in patch) || ('ttsEngine' in patch))) {
    config.set({ engines: enginesLib.deriveFromLegacy(config.get()) });
  }
  if (patch && patch.engines) {
    const e = enginesLib.normalizeEngines(config.get()).engines;
    config.set({
      mode: e.chat === 'offline' ? 'offline' : 'online',
      useLocalVision: e.vision === 'offline',
      useLocalStt: e.stt === 'offline',
      ttsEngine: e.tts === 'offline' ? 'piper' : 'browser'
    });
  }
```

and replace the ollamaBoot trigger condition:

```js
  const nowCfg = config.get();
  const needsOllama = enginesLib.resolveEngine(nowCfg, 'chat') === 'offline' || enginesLib.resolveEngine(nowCfg, 'vision') === 'offline';
  const needed = patch && (patch.engines || patch.mode === 'offline' || patch.useLocalVision === true);
  if (needed && needsOllama) ollamaBoot();
```

Also extend the existing chat-thread rebuild trigger — the visible thread follows the active store, and the store can swap when `engines.chat` flips (with `separateOfflineChats` on):

```js
  if (patch && (('mode' in patch) || ('separateOfflineChats' in patch) || ('engines' in patch))) {
    rebuildActivityFromMemory();
  }
```

- [ ] **Step 5: ui:status additions**

In the `ui:status` return object add:

```js
    engines: enginesLib.normalizeEngines(cfg).engines,
    wake_word_model: cfg.wakeWordModel || 'hey_jarvis_v0.1.onnx',
```

(the existing legacy fields `mode`, `use_local_vision`, `use_local_stt` now derive correctly because `config:set` keeps them in sync).

- [ ] **Step 6: Behavior-identical verification**

Run: `node tests/test-engines.js && npm start`, then in the app:
1. Old AI Mode card: flip Offline ON → status pill flips to Local, `settings.json` now shows `engines.chat === 'offline'`. Flip OFF → back, engines all `'online'`.
2. Online chat with your key still streams.
3. Settings → "Local voice input" toggle ON → `engines.stt === 'offline'` in settings.json.
4. Restart the app → toggles restore exactly (persistence requirement).
Expected: all four hold; no console errors.

- [ ] **Step 7: Commit**

```bash
git add main.js lib/config.js
git commit -m "refactor: route chat/vision/stt/tts through per-capability engines contract"
```

---

### Task 5: OS detection + Win10 solid fallback

**Files:**
- Modify: `main.js` (boot, `createOverlay` ~2252, new IPC), `preload.js`, `renderer/overlay.html`, `renderer/mini-overlay.html`, `renderer/index.html`

**Interfaces:**
- Produces: `shellStyle()` in main.js → `{ osVariant:'win11'|'win10'|'other', blur:boolean }`; IPC `shell:style`; preload `getShellStyle()`. Renderers set `document.documentElement.dataset.os`. (Task 11's onboarding and future sub-project D consume the same IPC.)

- [ ] **Step 1: Detection + helper in main.js**

Near the top (after the engines block from Task 4):

```js
// Windows 11 = build 22000+. Stored once, user-overridable in onboarding/Settings.
function detectOsVariant() {
  if (process.platform !== 'win32') return 'other';
  const build = parseInt((os.release() || '').split('.')[2] || '0', 10);
  return build >= 22000 ? 'win11' : 'win10';
}

function shellStyle() {
  const cfg = config.get();
  const osVariant = cfg.osVariant || detectOsVariant();
  return { osVariant, blur: osVariant === 'win11' };
}
```

In `app.whenReady`, before `createOverlay()`:

```js
  if (!config.get().osVariant) config.set({ osVariant: detectOsVariant() });
```

IPC (near `config:get`):

```js
ipcMain.handle('shell:style', () => shellStyle());
```

- [ ] **Step 2: Gate acrylic in createOverlay**

Line ~2257: `backgroundMaterial: process.platform === 'win32' ? 'acrylic' : undefined,` → `backgroundMaterial: (process.platform === 'win32' && shellStyle().blur) ? 'acrylic' : undefined,`

- [ ] **Step 3: preload + renderer hookup**

preload.js:

```js
  getShellStyle: () => ipcRenderer.invoke('shell:style'),
```

In `renderer/overlay.html`, `renderer/mini-overlay.html`, and `renderer/index.html`, add as the FIRST script statement of the page's boot code:

```js
window.bridge.getShellStyle().then(function (s) {
  document.documentElement.dataset.os = (s && s.osVariant) || 'win10';
}).catch(function () { document.documentElement.dataset.os = 'win10'; }); // fail solid, never fail transparent
```

- [ ] **Step 4: Solid fallback CSS**

In `renderer/overlay.html`, after the `#panel{...}` rule (the one carrying `backdrop-filter:blur(26px)` at ~line 46), add:

```css
/* Windows 10: DWM acrylic doesn't exist, so a transparent panel would show raw desktop
   through a tint. Same palette, fully solid, no backdrop-filter. */
html[data-os="win10"] #panel{
  background:#10141c;
  -webkit-backdrop-filter:none;backdrop-filter:none;
}
```

(mini-overlay.html needs no change — the orb is intentionally solid already; verify visually.)

- [ ] **Step 5: Verify both variants**

Run: `npm start`, expand the overlay: on this Win11 machine blur shows as before. Then force Win10: edit `%APPDATA%/Caryl.ai/settings.json` → `"osVariant": "win10"`, relaunch, expand overlay.
Expected: panel is fully solid (no acrylic, no see-through), everything else identical. Set back to `win11` (or delete the key) afterward.

- [ ] **Step 6: Commit**

```bash
git add main.js preload.js renderer/
git commit -m "feat: Win10/Win11 detection with acrylic-vs-solid overlay treatment"
```

---

### Task 6: Fix bubble position persistence

**Files:**
- Modify: `main.js` (`overlay:moveBy` handler ~2467)

Root cause: the bubble is dragged via IPC `overlay:moveBy` → `win.setPosition()` (programmatic). Electron's `'moved'` event — the only place `overlayBubblePos` is saved — fires for native title-bar drags (WM_EXITSIZEMOVE), which a frameless IPC-dragged window never produces. So drags were never persisted.

**Interfaces:** none new; `overlayBubblePos` + `config.overlayBubblePos` semantics unchanged, now actually written.

- [ ] **Step 1: Reproduce (proof the bug exists)**

Run: `npm start`, collapse the overlay to the bubble, drag the bubble somewhere distinctive, quit. Open `%APPDATA%/Caryl.ai/settings.json`.
Expected: `overlayBubblePos` is absent or stale (NOT the dragged position) — bug confirmed.

- [ ] **Step 2: Fix — persist from the drag path (debounced)**

Replace the `overlay:moveBy` handler with:

```js
let bubbleSaveTimer = null;
ipcMain.handle('overlay:moveBy', (event, dx, dy) => {
  // Move whichever window actually sent this (in practice always the bubble - the panel moves
  // via native OS drag on its title bar, not this IPC path) rather than assuming which one.
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return { ok: false };
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + (dx || 0)), Math.round(y + (dy || 0)));
  // Programmatic setPosition never fires 'moved' on Windows (that event needs a native
  // WM_EXITSIZEMOVE, which only title-bar drags produce) - so THIS is where the bubble's
  // position must be remembered. Debounced: one disk write per drag, not per pixel.
  if (miniOverlayWindow && !miniOverlayWindow.isDestroyed() && win === miniOverlayWindow) {
    const [px, py] = win.getPosition();
    overlayBubblePos = { x: px, y: py };
    clearTimeout(bubbleSaveTimer);
    bubbleSaveTimer = setTimeout(() => config.set({ overlayBubblePos }), 400);
  }
  return { ok: true };
});
```

- [ ] **Step 3: Flush pending save on quit**

Next to the existing `app.on('window-all-closed', ...)` add:

```js
app.on('before-quit', () => {
  // A drag within the last 400ms may still have a pending debounce - don't lose it.
  if (bubbleSaveTimer) { clearTimeout(bubbleSaveTimer); bubbleSaveTimer = null; }
  if (overlayBubblePos) config.set({ overlayBubblePos });
});
```

- [ ] **Step 4: Verify the acceptance criterion**

Run: `npm start` → collapse to bubble → drag to a distinctive spot → quit → relaunch → collapse to bubble again.
Expected: bubble reappears at the exact dragged spot. Repeat once with the bubble on a secondary monitor if attached. Also verify settings.json now holds the right `overlayBubblePos` within ~1s of ending a drag.

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "fix: bubble position now persists across sessions (moveBy path never fired 'moved')"
```

---

### Task 7: Low-RAM hardening (DevTools gate, dead deps, Whisper idle-unload)

**Files:**
- Modify: `main.js` (~2622), `package.json`, `automation.py` (~111–145, plus one endpoint pair used by Task 9)

**Interfaces:**
- Produces (Task 9 consumes): sidecar `GET /stt_status` → `{available:bool, cached:[names]}`; `POST /stt_warm` `{model}` → `{ok:bool, error?}`.

- [ ] **Step 1: Record the baseline RAM number**

Run (while the app from Task 6 is running, idle on the chat screen):
`powershell "Get-Process | Where-Object {$_.ProcessName -match 'electron|Caryl'} | Measure-Object WorkingSet64 -Sum | ForEach-Object { [math]::Round($_.Sum/1MB) }"`
Record the MB figure in the commit message of Step 6.

- [ ] **Step 2: Gate DevTools**

main.js ~2622, replace the TEMP DEBUG line with:

```js
  // DevTools only when explicitly asked for: `npm start -- --dev` or CARYL_DEV=1.
  if (process.argv.includes('--dev') || process.env.CARYL_DEV === '1') {
    mainWindow.webContents.once('did-finish-load', () => { try { mainWindow.webContents.openDevTools({ mode: 'detach' }); } catch (_e) {} });
  }
```

(F12 manual toggle at ~2664 stays.)

- [ ] **Step 3: Remove dead Picovoice deps**

Verify first: `grep -rn "picovoice" main.js preload.js renderer/ lib/` → expect no hits (wake word is openWakeWord).
Then remove `"@picovoice/porcupine-web"` and `"@picovoice/web-voice-processor"` from package.json dependencies and run `npm install` to update the lockfile.

- [ ] **Step 4: Whisper idle-unload + status/warm endpoints in automation.py**

Below `_get_whisper` (~line 143) add, and start the reaper thread next to where the Flask app's other background threads start (search `threading.Thread` in the file and mirror that pattern):

```python
_WHISPER_LAST_USED = 0.0
_WHISPER_IDLE_S = 300  # unload models after 5 idle minutes; reload cost is one cold start


def _touch_whisper():
    global _WHISPER_LAST_USED
    _WHISPER_LAST_USED = time.time()


def _whisper_idle_reaper():
    while True:
        time.sleep(60)
        with _whisper_lock:
            if _WHISPER_LRU and _WHISPER_LAST_USED and (time.time() - _WHISPER_LAST_USED) > _WHISPER_IDLE_S:
                _WHISPER_LRU.clear()
                gc.collect()


threading.Thread(target=_whisper_idle_reaper, daemon=True).start()
```

Add `import gc` with the other imports if absent. In `_get_whisper`, call `_touch_whisper()` as the first line inside the lock. Then add the two endpoints next to `/transcribe`:

```python
@app.route("/stt_status", methods=["GET"])
def stt_status():
    with _whisper_lock:
        return jsonify({"available": _FWModel is not None, "cached": list(_WHISPER_LRU.keys()),
                        "error": _fw_import_error})


@app.route("/stt_warm", methods=["POST"])
def stt_warm():
    if _FWModel is None:
        return jsonify({"ok": False, "error": "faster-whisper not installed: %s" % _fw_import_error})
    name = (request.get_json(silent=True) or {}).get("model") or "base.en"
    try:
        _get_whisper(name)  # downloads on first ever use, then caches locally
        return jsonify({"ok": True, "model": name})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})
```

- [ ] **Step 5: Verify**

1. `npm start` → no DevTools window appears. `npm start -- --dev` → it does.
2. `node -e "console.log(Object.keys(require('./package.json').dependencies))"` → no picovoice entries; `npm start` still boots clean.
3. Python syntax check: `.venv/Scripts/python.exe -m py_compile automation.py` → exit 0.
4. With the sidecar running (trigger any automation/voice feature once): `curl http://127.0.0.1:7842/stt_status` → JSON with `available` field.

- [ ] **Step 6: Measure again + commit**

Re-run the Step 1 PowerShell one-liner; record both numbers:

```bash
git add main.js package.json package-lock.json automation.py
git commit -m "perf: gate DevTools, drop dead picovoice deps, whisper idle-unload (idle RAM: <before>MB -> <after>MB)"
```

---

### Task 8: Curated multi-wake-word support

**Files:**
- Modify: `main.js` (~2168 `WAKEWORD_MODELS`, `wakeword:ensure` ~2175, `ui:status`), `renderer/wakeword.js`, `renderer/index.html` (~1604)

**Interfaces:**
- Consumes: `cfg.wakeWordModel` default from Task 4.
- Produces (Task 11 consumes): `WAKE_WORD_CHOICES` exposed via `ui:status.wake_word_choices`; `WakeWord.start({threshold, model})` accepts a model file name.

- [ ] **Step 1: Extend the model map in main.js**

Replace `WAKEWORD_MODELS` (~2168) with:

```js
const WAKEWORD_BASE = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/';
const WAKEWORD_CORE = {
  'melspectrogram.onnx': WAKEWORD_BASE + 'melspectrogram.onnx',
  'embedding_model.onnx': WAKEWORD_BASE + 'embedding_model.onnx'
};
// Curated pretrained classifiers - the phrases openWakeWord ships reliable models for.
// (Arbitrary custom names would need per-phrase training; deliberately out of scope.)
const WAKE_WORD_CHOICES = [
  { file: 'hey_jarvis_v0.1.onnx', label: 'Jarvis', phrase: 'Hey Jarvis' },
  { file: 'alexa_v0.1.onnx', label: 'Alexa', phrase: 'Alexa' },
  { file: 'hey_mycroft_v0.1.onnx', label: 'Mycroft', phrase: 'Hey Mycroft' },
  { file: 'hey_rhasspy_v0.1.onnx', label: 'Rhasspy', phrase: 'Hey Rhasspy' }
];
const WAKEWORD_MODELS = Object.assign({}, WAKEWORD_CORE);
WAKE_WORD_CHOICES.forEach((c) => { WAKEWORD_MODELS[c.file] = WAKEWORD_BASE + c.file; });
```

Verify the four classifier URLs exist before committing:
Run: `for f in hey_jarvis_v0.1.onnx alexa_v0.1.onnx hey_mycroft_v0.1.onnx hey_rhasspy_v0.1.onnx; do curl -sIL -o /dev/null -w "%{http_code} $f\n" https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/$f; done`
Expected: `200` for each. If any 404s, check the release assets at github.com/dscripka/openWakeWord/releases and correct the file name in `WAKE_WORD_CHOICES`.

- [ ] **Step 2: Download only core + the SELECTED classifier**

In `wakeword:ensure` (~2180), replace `const names = Object.keys(WAKEWORD_MODELS);` with:

```js
    const selected = config.get().wakeWordModel || 'hey_jarvis_v0.1.onnx';
    const names = Object.keys(WAKEWORD_CORE).concat(
      Object.prototype.hasOwnProperty.call(WAKEWORD_MODELS, selected) ? [selected] : ['hey_jarvis_v0.1.onnx']
    );
```

- [ ] **Step 3: Expose choices in ui:status**

Add to the `ui:status` return object: `wake_word_choices: WAKE_WORD_CHOICES,` (next to `wake_word_model` from Task 4).

- [ ] **Step 4: Parameterize renderer/wakeword.js**

Add a module variable next to `let threshold = 0.5;`: `let wwModelName = 'hey_jarvis_v0.1.onnx';`
In `load()` replace `wwSession = await makeSession('hey_jarvis_v0.1.onnx');` with `wwSession = await makeSession(wwModelName);`
In `start(opts)` before `await load();` add:

```js
        if (opts.model && opts.model !== wwModelName) { wwModelName = String(opts.model); loaded = false; }
```

Change the two status strings: `status('Listening for “Hey Jarvis”…')` → `status('Listening for the wake word…')` and the header comment mention if desired; in `processStep`, `log('DETECTED hey_jarvis ...')` → `log('DETECTED ' + wwModelName + ' score=' + score.toFixed(3))`.

- [ ] **Step 5: Pass the configured model at the call site**

renderer/index.html ~1604, replace `await WakeWord.start({ threshold: thr });` with:

```js
      const cfgWW = await window.bridge.getConfig();
      await WakeWord.start({ threshold: thr, model: cfgWW.wakeWordModel || undefined });
```

- [ ] **Step 6: Verify**

`npm start` → Settings → enable wake word → say "Hey Jarvis" → detection fires (unchanged default). Then in settings.json set `"wakeWordModel": "alexa_v0.1.onnx"`, relaunch, re-enable → console shows the alexa model downloading once, and saying "Alexa" fires detection while "Hey Jarvis" does not.

- [ ] **Step 7: Commit**

```bash
git add main.js renderer/wakeword.js renderer/index.html
git commit -m "feat: curated wake-word choices (Jarvis/Alexa/Mycroft/Rhasspy), selectable + persisted"
```

---

### Task 9: `lib/downloads.js` — asset registry + IPC

**Files:**
- Create: `lib/downloads.js`
- Modify: `main.js` (IPC registration + export hookups), `lib/ollama.js` (export `findExe`), `preload.js`

**Interfaces:**
- Consumes: `ollama.isUp/listTags/pullModel/findExe`, sidecar `GET /stt_status` + `POST /stt_warm` (Task 7), `WAKEWORD_MODELS`/`wakewordDir()` file checks, `cfg.piperPath/piperModel`, engines contract.
- Produces (Task 10/11 consume):
  - IPC `downloads:status` → `[{ id, label, sizeMB, installed, detail }]`
  - IPC `downloads:start` `(id)` → `{ ok, error?, external? }` with progress events on channel `downloads:progress` `{ id, msg }`
  - Asset ids: `'ollama-runtime' | 'chat-model' | 'vision-model' | 'whisper-stt' | 'piper-voice' | 'wakeword-models' | 'python-deps'`
  - preload: `downloadsStatus()`, `downloadsStart(id)`, `onDownloadsProgress(cb)`

- [ ] **Step 1: Export findExe from lib/ollama.js**

Add `findExe,` to the `module.exports` object at ~line 357.

- [ ] **Step 2: Write lib/downloads.js**

```js
// lib/downloads.js
// The one registry of every heavy on-demand asset. The installer ships code only; this
// module answers "what's installed?" and "start installing X" for the Engines & Models
// panel and onboarding. It orchestrates the EXISTING downloaders (ollama.pullModel, the
// wake-word ensure handler, the Piper voice installer) rather than reimplementing them.
const fs = require('fs');
const path = require('path');

// deps injected once from main.js so this file needs no Electron imports of its own:
// { config, ollama, wakewordDir, wakewordFiles, sidecarGet, sidecarPost, ensureWakeword, defaultOfflineModel }
let D = null;
function init(deps) { D = deps; }

function fileOk(p) { try { return fs.statSync(p).size > 1000; } catch (_e) { return false; } }

async function status() {
  const cfg = D.config.get();
  const tags = D.ollama.isUp() ? await D.ollama.listTags().catch(() => []) : [];
  const chatModel = cfg.offlineModel || D.defaultOfflineModel;
  const visionModel = cfg.offlineVisionModel || 'moondream';
  const stt = await D.sidecarGet('/stt_status').catch(() => null); // null = sidecar not running
  const wwDir = D.wakewordDir();
  const wwSelected = cfg.wakeWordModel || 'hey_jarvis_v0.1.onnx';
  const wwInstalled = D.wakewordFiles().every((f) => fileOk(path.join(wwDir, f))) && fileOk(path.join(wwDir, wwSelected));
  return [
    { id: 'ollama-runtime', label: 'Ollama runtime', sizeMB: 700,
      installed: D.ollama.isUp() || !!D.ollama.findExe(),
      detail: D.ollama.isUp() ? 'running' : (D.ollama.findExe() ? 'installed (not running)' : 'not installed') },
    { id: 'chat-model', label: 'Offline chat model (' + chatModel + ')', sizeMB: 4700,
      installed: tags.some((t) => t === chatModel || String(t).indexOf(chatModel) === 0),
      detail: D.ollama.isUp() ? '' : 'needs Ollama running to check' },
    { id: 'vision-model', label: 'Offline vision model (' + visionModel + ')', sizeMB: 1700,
      installed: tags.some((t) => t === visionModel || String(t).indexOf(visionModel) === 0),
      detail: D.ollama.isUp() ? '' : 'needs Ollama running to check' },
    { id: 'whisper-stt', label: 'Offline voice input (faster-whisper)', sizeMB: 75,
      installed: !!(stt && stt.available && (stt.cached || []).length),
      detail: stt ? (stt.available ? (stt.cached.length ? 'model cached' : 'installed, no model cached yet') : 'python package missing') : 'sidecar not running' },
    { id: 'piper-voice', label: 'Offline voice output (Piper)', sizeMB: 110,
      installed: !!(cfg.piperPath && cfg.piperModel && fileOk(cfg.piperModel)),
      detail: cfg.piperModel ? path.basename(cfg.piperModel) : 'no voice installed' },
    { id: 'wakeword-models', label: 'Wake-word models', sizeMB: 6,
      installed: wwInstalled, detail: wwSelected }
  ];
}

// Returns {ok} / {ok:false,error} / {ok:true,external:true} (= we opened a browser page,
// e.g. the Ollama installer - we never silently install other vendors' software).
async function start(id, onProgress) {
  const cfg = D.config.get();
  const send = (msg) => { try { onProgress(msg); } catch (_e) {} };
  if (id === 'ollama-runtime') return { ok: true, external: true }; // caller opens ollama.com/download
  if (id === 'chat-model' || id === 'vision-model') {
    const model = id === 'chat-model' ? (cfg.offlineModel || D.defaultOfflineModel) : (cfg.offlineVisionModel || 'moondream');
    if (!D.ollama.isUp()) return { ok: false, error: 'Ollama isn’t running - install/start it first.' };
    await D.ollama.pullModel(model, send);
    return { ok: true };
  }
  if (id === 'whisper-stt') {
    send('Preparing local voice input… (first time downloads ~75 MB)');
    const r = await D.sidecarPost('/stt_warm', { model: cfg.offlineSttModel || 'base.en' }).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
    return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'sidecar unavailable' };
  }
  if (id === 'wakeword-models') { const r = await D.ensureWakeword(); return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'download failed' }; }
  if (id === 'piper-voice') return { ok: false, error: 'use-voice-installer' }; // panel routes to the existing voice installer UI
  return { ok: false, error: 'unknown asset: ' + id };
}

module.exports = { init, status, start };
```

- [ ] **Step 3: Wire into main.js**

Near the other requires: `const downloads = require('./lib/downloads');`

After the wake-word section (so `wakewordDir`/`WAKEWORD_CORE` exist), initialize + register IPC:

```js
downloads.init({
  config, ollama,
  defaultOfflineModel: DEFAULT_OFFLINE_MODEL,
  wakewordDir,
  wakewordFiles: () => Object.keys(WAKEWORD_CORE),
  ensureWakeword: () => ensureWakewordModels(),          // see note below
  sidecarGet: (p) => sidecarCall(p, null, 'GET'),        // adapt to sidecarCall's real signature
  sidecarPost: (p, body) => sidecarCall(p, body)
});

ipcMain.handle('downloads:status', () => downloads.status());
ipcMain.handle('downloads:start', async (e, id) => {
  const send = (msg) => { try { e.sender.send('downloads:progress', { id, msg }); } catch (_e2) {} };
  const r = await downloads.start(id, send);
  if (r && r.external) shell.openExternal('https://ollama.com/download');
  send(''); // clear progress line
  return r;
});
```

**Adaptation notes (read the surrounding code, don't guess):** (a) `wakeword:ensure`'s body must be extracted into a plain `async function ensureWakewordModels()` that the IPC handler AND downloads both call. (b) `sidecarCall` in main.js — check its actual signature (`grep -n "function sidecarCall" main.js`) and adapt the two lambdas; if it's POST-only, add a tiny `sidecarGetJson(path)` helper using `fetch('http://127.0.0.1:7842' + path)`. The sidecar may need `ensureSidecar()` first for `whisper-stt` — mirror how `stt:transcribe` does it.

- [ ] **Step 4: preload additions**

```js
  // ----- Engines & Models download manager -----
  downloadsStatus: () => ipcRenderer.invoke('downloads:status'),
  downloadsStart: (id) => ipcRenderer.invoke('downloads:start', id),
  onDownloadsProgress: (cb) => ipcRenderer.on('downloads:progress', (_e, p) => cb(p)),
```

- [ ] **Step 5: Verify via DevTools console**

Run: `npm start -- --dev`, in the console:
`await bridge.downloadsStatus()` → array of 6 assets with sane `installed` values for this machine.
`bridge.onDownloadsProgress(p => console.log('DL', p)); await bridge.downloadsStart('wakeword-models')` → `{ok:true}` (models already present → instant).
Expected: no errors; statuses match reality (Ollama installed? voice installed? etc.).

- [ ] **Step 6: Commit**

```bash
git add lib/downloads.js lib/ollama.js main.js preload.js
git commit -m "feat: unified download manager registry for all heavy on-demand assets"
```

---

### Task 10: Engines & Models settings panel

**Files:**
- Modify: `renderer/index.html` (AI Mode card ~196–260 and its JS ~758–770, ~925–945, ~1734)

**Interfaces:**
- Consumes: `ui:status.engines`, `bridge.setConfig({engines})`, `bridge.downloadsStatus/downloadsStart/onDownloadsProgress` (Tasks 4/9).
- Produces: the four-toggle hybrid UI; legacy `tog-offline`/`tog-localvision`/`tog-localstt` toggles and their handler functions are DELETED (config:set legacy translation keeps very old renderers working, but this renderer moves fully to `engines`).

- [ ] **Step 1: Replace the card header + mode toggle block**

Replace the "AI Mode" `h3`/`sub`/`tog-offline` row (~lines 199–202) with:

```html
      <h3>Engines &amp; Models</h3>
      <div class="sub">Each capability runs in the cloud or on this PC &mdash; mix freely. <span id="am-badge" class="badge">&mdash;</span></div>
      <div id="engine-rows">
        <div class="row"><div><div class="l">Chat</div><div class="d" id="eng-chat-d">&mdash;</div></div>
          <label class="sw"><input type="checkbox" id="eng-chat" onchange="setEngine('chat',this.checked)"><span></span></label></div>
        <div class="row"><div><div class="l">Vision</div><div class="d" id="eng-vision-d">&mdash;</div></div>
          <label class="sw"><input type="checkbox" id="eng-vision" onchange="setEngine('vision',this.checked)"><span></span></label></div>
        <div class="row"><div><div class="l">Voice input (STT)</div><div class="d" id="eng-stt-d">&mdash;</div></div>
          <label class="sw"><input type="checkbox" id="eng-stt" onchange="setEngine('stt',this.checked)"><span></span></label></div>
        <div class="row"><div><div class="l">Voice output (TTS)</div><div class="d" id="eng-tts-d">&mdash;</div></div>
          <label class="sw"><input type="checkbox" id="eng-tts" onchange="setEngine('tts',this.checked)"><span></span></label></div>
      </div>
      <div class="d" style="margin:4px 0 8px">Toggle ON = runs locally on this PC (private, needs a one-time download). OFF = cloud API.</div>
      <div id="downloads-list"></div>
```

Keep the existing "Start / refresh Ollama" field row and the `offline-chat-block` / `offline-vision-block` sections exactly as they are (they're the model pickers the download manager complements).

- [ ] **Step 2: New JS wiring (add near the old toggleOfflineMode, which you delete)**

```js
// ---- Engines & Models (per-capability hybrid routing) ----
let _engines = { chat: 'online', vision: 'online', stt: 'online', tts: 'online' };
async function setEngine(cap, offlineOn) {
  _engines = Object.assign({}, _engines);
  _engines[cap] = offlineOn ? 'offline' : 'online';
  await window.bridge.setConfig({ engines: _engines });
  if (offlineOn) refreshDownloadsList(); // surface any missing model immediately
  applyOfflineFieldVisibility();
}

function applyEnginesToUi(s) { // called from the existing status-poll apply function
  if (!s || !s.engines) return;
  _engines = s.engines;
  ['chat', 'vision', 'stt', 'tts'].forEach(function (cap) {
    const t = document.getElementById('eng-' + cap);
    if (t && document.activeElement !== t) t.checked = _engines[cap] === 'offline';
    const d = document.getElementById('eng-' + cap + '-d');
    if (d) d.textContent = _engines[cap] === 'offline' ? 'Local (this PC)' : 'Cloud API';
  });
  const badge = document.getElementById('am-badge');
  if (badge) {
    const local = ['chat', 'vision', 'stt', 'tts'].filter(function (c) { return _engines[c] === 'offline'; });
    badge.textContent = local.length === 0 ? 'All cloud' : (local.length === 4 ? 'All local' : 'Hybrid: ' + local.join('+') + ' local');
  }
}

async function refreshDownloadsList() {
  const el = document.getElementById('downloads-list');
  if (!el) return;
  let assets = [];
  try { assets = await window.bridge.downloadsStatus(); } catch (e) { el.innerHTML = '<div class="statusline bad">' + esc(String(e)) + '</div>'; return; }
  el.innerHTML = assets.map(function (a) {
    const state = a.installed ? '<span style="color:#7dff9a">&#9679; installed</span>' : '<span style="color:#889">&#9675; ~' + a.sizeMB + ' MB</span>';
    const btn = a.installed ? '' : '<button class="minibtn" onclick="startDownload(\'' + a.id + '\')">Download</button>';
    return '<div class="row" style="align-items:center"><div><div class="l">' + esc(a.label) + '</div><div class="d">' + state + (a.detail ? ' &middot; ' + esc(a.detail) : '') + ' <span id="dlp-' + a.id + '"></span></div></div>' + btn + '</div>';
  }).join('');
}

async function startDownload(id) {
  const r = await window.bridge.downloadsStart(id);
  if (r && r.error === 'use-voice-installer') { alert('Pick and install a voice in the Voice section below — it handles the download.'); return; }
  if (r && !r.ok) alert('Download failed: ' + (r.error || 'unknown'));
  refreshDownloadsList();
}
window.bridge.onDownloadsProgress(function (p) {
  const el = document.getElementById('dlp-' + p.id);
  if (el) el.textContent = p.msg || '';
});
```

- [ ] **Step 3: Delete the legacy wiring**

Remove `toggleOfflineMode()`, the `tog-localvision`/`tog-localstt` rows + their onchange functions (~933–940), and the `set('tog-localvision', ...)`/`set('tog-localstt', ...)` lines in the status apply (~768–769). In the status-poll apply function (~1734 region) call `applyEnginesToUi(s)` instead of the old AI-Mode card update, and keep `applyOfflineFieldVisibility()` but drive it from `_engines`: chat-model block visible when `_engines.chat === 'offline'`, vision block when `_engines.vision === 'offline'`. Call `refreshDownloadsList()` once when the Settings drawer opens (find the existing settings-open handler and append the call).

- [ ] **Step 4: Verify the spec's acceptance scenarios**

`npm start`:
1. Four toggles reflect saved state; flip Vision ON (offline) with no Ollama vision model → downloads list shows vision model row as not installed with a Download button (no silent failure).
2. Set your hybrid example: Vision=offline, Chat=online (cloud key), STT=offline → chat streams from cloud; "what's on my screen" uses the local model (watch console `[engines]`/model names); voice input transcribes locally.
3. Restart → all four toggles restore (the user's core persistence requirement).
4. Badge reads "Hybrid: vision+stt local".

- [ ] **Step 5: Commit**

```bash
git add renderer/index.html
git commit -m "feat: Engines & Models panel - per-capability hybrid toggles + download manager UI"
```

---

### Task 11: First-launch onboarding wizard

**Files:**
- Create: `renderer/onboarding.html`
- Modify: `main.js` (`createWindow` ~2619, new IPC), `preload.js`, `renderer/index.html` (Redo setup button)

**Interfaces:**
- Consumes: `shell:style` (Task 5), `ui:status.wake_word_choices` (Task 8), existing `voice:list/install/use`, `tts:test`, `wakeword:ensure`, `WakeWord` engine, `media:ensure` (new, below), `assistant:setName` behavior via config.
- Produces: IPC `onboarding:complete(patch)` and `onboarding:redo`; preload `ensureMedia()`, `onboardingComplete(patch)`, `redoSetup()`; config `onboarded: true`.

- [ ] **Step 1: main.js — route first launch to the wizard**

In `createWindow()` replace `mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));` with:

```js
  const entryPage = config.get().onboarded === true ? 'index.html' : 'onboarding.html';
  mainWindow.loadFile(path.join(__dirname, 'renderer', entryPage));
```

Inside `createWindow()` after `ensureMediaPermission` is defined, register (idempotently — createWindow can rerun on macOS activate):

```js
  ipcMain.removeHandler('media:ensure');
  ipcMain.handle('media:ensure', () => ensureMediaPermission());
```

Near the other IPC handlers add:

```js
// Wizard finished (or was skipped): persist choices, mark done, swap to the real app.
ipcMain.handle('onboarding:complete', (_e, patch) => {
  const p = patch || {};
  const clean = { onboarded: true };
  if (typeof p.assistantName === 'string' && p.assistantName.trim()) clean.assistantName = p.assistantName.trim().slice(0, 40);
  if (typeof p.wakeWordModel === 'string' && p.wakeWordModel) clean.wakeWordModel = p.wakeWordModel;
  if (p.osVariant === 'win10' || p.osVariant === 'win11') clean.osVariant = p.osVariant;
  if (typeof p.globalHotkey === 'string' && p.globalHotkey) clean.globalHotkey = p.globalHotkey;
  if (typeof p.wakeThreshold === 'number') clean.local_wake_threshold = Math.max(0.05, Math.min(0.95, p.wakeThreshold));
  config.set(clean);
  applyVoiceHotkeyMode();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return { ok: true };
});

ipcMain.handle('onboarding:redo', () => {
  config.set({ onboarded: false });
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile(path.join(__dirname, 'renderer', 'onboarding.html'));
  return { ok: true };
});
```

- [ ] **Step 2: preload additions**

```js
  // ----- Onboarding -----
  ensureMedia: () => ipcRenderer.invoke('media:ensure'),
  onboardingComplete: (patch) => ipcRenderer.invoke('onboarding:complete', patch),
  redoSetup: () => ipcRenderer.invoke('onboarding:redo'),
```

- [ ] **Step 3: Create renderer/onboarding.html**

Self-contained wizard, 7 steps, dark theme matching the app (`#0b0d12` bg, `#7fd1ff` accent), every step skippable, Esc = skip all. Complete file:

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Welcome to Caryl.ai</title>
<style>
  :root{--bg:#0b0d12;--card:#11141c;--txt:#e8ecf3;--mut:#9aa4b5;--accent:#7fd1ff;--line:rgba(255,255,255,.10)}
  html,body{height:100%;margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 "Segoe UI",system-ui,sans-serif}
  .wrap{max-width:620px;margin:0 auto;padding:48px 24px;display:flex;flex-direction:column;min-height:calc(100% - 96px)}
  .step{display:none;flex:1}
  .step.on{display:block;animation:fade .25s ease}
  @keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1}}
  h1{font-size:26px;margin:0 0 6px}
  .sub{color:var(--mut);margin-bottom:22px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:10px 0}
  .opt{display:flex;align-items:center;gap:12px;padding:12px;border:1px solid var(--line);border-radius:10px;margin:8px 0;cursor:pointer}
  .opt.sel{border-color:var(--accent);background:rgba(127,209,255,.08)}
  input[type=text]{width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:10px 12px;font:inherit}
  input[type=range]{width:100%}
  .nav{display:flex;justify-content:space-between;align-items:center;padding-top:18px}
  button{background:var(--accent);border:none;color:#06121c;border-radius:9px;padding:10px 22px;font:inherit;font-weight:600;cursor:pointer}
  button.ghost{background:transparent;color:var(--mut);border:1px solid var(--line)}
  .meter{height:8px;background:rgba(255,255,255,.08);border-radius:4px;overflow:hidden}
  .meter>div{height:100%;width:0;background:var(--accent);transition:width .12s}
  .preview{display:flex;gap:12px}
  .pv{flex:1;height:110px;border-radius:10px;border:1px solid var(--line);position:relative;overflow:hidden;
      background:linear-gradient(120deg,#28577e,#7a3d6e,#2c7a5c)}
  .pv .glass{position:absolute;inset:14px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff}
  .pv .blur{background:rgba(16,20,28,.45);backdrop-filter:blur(10px)}
  .pv .solid{background:#10141c}
  .status{color:var(--mut);font-size:12px;min-height:18px;margin-top:8px}
  .dots{display:flex;gap:6px;justify-content:center;margin-bottom:26px}
  .dots span{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.15)}
  .dots span.on{background:var(--accent)}
</style>
</head>
<body>
<div class="wrap">
  <div class="dots" id="dots"></div>

  <div class="step" data-step="0">
    <h1>Welcome to Caryl.ai</h1>
    <div class="sub" id="welcome-sub">Your fast, private desktop AI companion. A minute of setup, then she's yours.</div>
    <div class="card">Everything you pick here can be changed later in Settings. Press <b>Esc</b> anytime to skip setup entirely.</div>
  </div>

  <div class="step" data-step="1">
    <h1>Name your assistant</h1>
    <div class="sub">The wake word is what she listens for; the display name is what she calls herself.</div>
    <div id="ww-list"></div>
    <div class="card">
      <div style="margin-bottom:6px;color:var(--mut);font-size:12px">Display name (free choice)</div>
      <input type="text" id="display-name" placeholder="Caryl" maxlength="40">
    </div>
  </div>

  <div class="step" data-step="2">
    <h1>Your Windows version</h1>
    <div class="sub" id="os-sub">Detected automatically &mdash; it controls whether overlays use real blur (Win 11) or solid panels (Win 10).</div>
    <div class="opt" data-os="win11" onclick="pickOs('win11')"><div><b>Windows 11</b><div style="color:var(--mut);font-size:12px">Transparent acrylic blur</div></div></div>
    <div class="opt" data-os="win10" onclick="pickOs('win10')"><div><b>Windows 10</b><div style="color:var(--mut);font-size:12px">Solid backgrounds (native blur unsupported)</div></div></div>
    <div class="preview"><div class="pv"><div class="glass" id="pv-glass">overlay preview</div></div></div>
  </div>

  <div class="step" data-step="3">
    <h1>Microphone &amp; camera</h1>
    <div class="sub">Needed for voice chat and camera vision. Asked once, remembered forever.</div>
    <div class="card"><button onclick="grantMedia()">Allow microphone &amp; camera</button><div class="status" id="media-status"></div></div>
  </div>

  <div class="step" data-step="4">
    <h1>Pick a voice</h1>
    <div class="sub">The built-in system voice works instantly. Neural voices download once (~110 MB) and run locally.</div>
    <div id="voice-list"><div class="status">Loading voices&hellip;</div></div>
    <div class="status" id="voice-status"></div>
  </div>

  <div class="step" data-step="5">
    <h1>Wake-word check</h1>
    <div class="sub" id="cal-sub">Say your wake word a few times and watch the meter. Lower the slider if she misses you; raise it if she false-triggers.</div>
    <div class="card">
      <div class="meter"><div id="cal-meter"></div></div>
      <div style="margin-top:12px"><input type="range" id="cal-thresh" min="0.1" max="0.9" step="0.05" value="0.5"></div>
      <div class="status" id="cal-status">Starting detector&hellip;</div>
    </div>
  </div>

  <div class="step" data-step="6">
    <h1>Global voice hotkey</h1>
    <div class="sub">Toggles listening from anywhere, even when Caryl is in the background.</div>
    <div class="card"><input type="text" id="hotkey" readonly placeholder="Click, then press a key combo" onkeydown="captureHotkey(event)" onclick="this.value=''"></div>
  </div>

  <div class="nav">
    <button class="ghost" id="btn-back" onclick="nav(-1)">Back</button>
    <button class="ghost" onclick="finish(true)">Skip setup</button>
    <button id="btn-next" onclick="nav(1)">Next</button>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.1/dist/ort.min.js"></script>
<script src="wakeword.js"></script>
<script>
  const TOTAL = 7;
  let step = 0;
  const picked = { wakeWordModel: 'hey_jarvis_v0.1.onnx', osVariant: '', assistantName: '', globalHotkey: '', wakeThreshold: 0.5 };

  const dots = document.getElementById('dots');
  for (let i = 0; i < TOTAL; i++) { const s = document.createElement('span'); dots.appendChild(s); }
  function show() {
    document.querySelectorAll('.step').forEach(el => el.classList.toggle('on', +el.dataset.step === step));
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i <= step));
    document.getElementById('btn-back').style.visibility = step === 0 ? 'hidden' : 'visible';
    document.getElementById('btn-next').textContent = step === TOTAL - 1 ? 'Finish' : 'Next';
    if (step === 4) loadVoices();
    if (step === 5) startCalibration(); else stopCalibration();
  }
  function nav(d) { if (step + d >= TOTAL) return finish(false); step = Math.max(0, step + d); show(); }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') finish(true); });

  async function finish(skipped) {
    stopCalibration();
    picked.assistantName = (document.getElementById('display-name').value || '').trim();
    await window.bridge.onboardingComplete(skipped ? {} : picked);
  }

  // step 1: wake word choices from main (curated pretrained models)
  (async function init() {
    const st = await window.bridge.status();
    const choices = st.wake_word_choices || [];
    const list = document.getElementById('ww-list');
    list.innerHTML = choices.map(c =>
      '<div class="opt" data-ww="' + c.file + '" onclick="pickWw(\'' + c.file + '\')"><div><b>' + c.label + '</b><div style="color:var(--mut);font-size:12px">say “' + c.phrase + '”</div></div></div>').join('');
    pickWw(picked.wakeWordModel);
    const shell = await window.bridge.getShellStyle();
    pickOs(shell.osVariant === 'win10' ? 'win10' : 'win11');
    document.getElementById('os-sub').textContent = 'We detected ' + (shell.osVariant === 'win10' ? 'Windows 10' : 'Windows 11') + ' — override if that’s wrong.';
    const cfg = await window.bridge.getConfig();
    if (cfg.migratedFrom) document.getElementById('welcome-sub').textContent = 'Your BRAIN.AI chats, settings, and key came along — nothing to redo.';
    show();
  })();
  function pickWw(f) { picked.wakeWordModel = f; document.querySelectorAll('[data-ww]').forEach(el => el.classList.toggle('sel', el.dataset.ww === f)); }
  function pickOs(v) {
    picked.osVariant = v;
    document.querySelectorAll('[data-os]').forEach(el => el.classList.toggle('sel', el.dataset.os === v));
    const g = document.getElementById('pv-glass'); g.className = 'glass ' + (v === 'win11' ? 'blur' : 'solid');
  }

  // step 3
  async function grantMedia() {
    const ok = await window.bridge.ensureMedia();
    document.getElementById('media-status').textContent = ok ? '✓ Allowed' : 'Blocked — you can change this later in Settings.';
  }

  // step 4: reuse the existing voice installer IPC
  let voicesLoaded = false;
  async function loadVoices() {
    if (voicesLoaded) return; voicesLoaded = true;
    const el = document.getElementById('voice-list');
    try {
      const r = await window.bridge.listVoices();
      const voices = (r && r.voices) || r || [];
      el.innerHTML = '<div class="opt sel" onclick="this.parentNode.querySelectorAll(\'.opt\').forEach(o=>o.classList.remove(\'sel\'));this.classList.add(\'sel\')"><div><b>System voice</b><div style="color:var(--mut);font-size:12px">instant, no download</div></div></div>' +
        voices.map(v => '<div class="opt" onclick="installVoice(\'' + (v.id || v) + '\',this)"><div><b>' + (v.name || v.id || v) + '</b><div style="color:var(--mut);font-size:12px">local neural voice · downloads once</div></div></div>').join('');
    } catch (e) { el.innerHTML = '<div class="status">Voice list unavailable (offline?) — the system voice is active; add neural voices later in Settings.</div>'; }
  }
  async function installVoice(id, el) {
    document.getElementById('voice-status').textContent = 'Installing ' + id + '…';
    window.bridge.onVoiceProgress(m => { document.getElementById('voice-status').textContent = m || ''; });
    const r = await window.bridge.installVoice(id);
    document.getElementById('voice-status').textContent = (r && r.ok) ? '✓ Voice ready' : ('Failed: ' + ((r && r.error) || 'unknown'));
    if (r && r.ok) { document.querySelectorAll('#voice-list .opt').forEach(o => o.classList.remove('sel')); el.classList.add('sel'); }
  }

  // step 5: live calibration on the real detector
  let calOn = false;
  async function startCalibration() {
    if (calOn || !window.WakeWord) return;
    if (typeof ort === 'undefined') { document.getElementById('cal-status').textContent = 'Needs internet once (detector runtime) — skip for now, calibrate later in Settings.'; return; }
    // wakeword:ensure downloads the model named in cfg.wakeWordModel - persist the wizard's
    // pick FIRST or the ensure step fetches the old default and load() fails "not downloaded".
    await window.bridge.setConfig({ wakeWordModel: picked.wakeWordModel });
    calOn = true;
    const meter = document.getElementById('cal-meter'), stat = document.getElementById('cal-status');
    document.getElementById('cal-thresh').oninput = e => { picked.wakeThreshold = parseFloat(e.target.value); WakeWord.setThreshold(picked.wakeThreshold); };
    WakeWord.on('score', s => { meter.style.width = Math.min(100, Math.round(s * 100)) + '%'; });
    WakeWord.on('detect', () => { stat.textContent = '✓ Heard you! That threshold works.'; });
    WakeWord.on('status', s => { if (!/Heard/.test(stat.textContent)) stat.textContent = s; });
    try { await WakeWord.start({ threshold: picked.wakeThreshold, model: picked.wakeWordModel }); }
    catch (e) { stat.textContent = 'Detector unavailable: ' + ((e && e.message) || e) + ' — skip and calibrate later in Settings.'; calOn = false; }
  }
  function stopCalibration() { if (calOn && window.WakeWord) { try { WakeWord.stop(); } catch (e) {} calOn = false; } }

  // step 6
  function captureHotkey(e) {
    e.preventDefault();
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const parts = [];
    if (e.ctrlKey) parts.push('CommandOrControl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
    picked.globalHotkey = parts.join('+');
    e.target.value = picked.globalHotkey;
  }
</script>
</body>
</html>
```

- [ ] **Step 4: Redo setup button in Settings**

In `renderer/index.html`, at the bottom of the Settings drawer (find the last `.sec` block), add:

```html
    <div class="sec">
      <h3>Setup</h3>
      <div class="row"><div><div class="l">Run first-launch setup again</div><div class="d">Name, wake word, Windows version, voice, calibration, hotkey.</div></div>
        <button class="minibtn" onclick="window.bridge.redoSetup()">Redo setup</button></div>
    </div>
```

- [ ] **Step 5: Verify the full wizard**

1. In settings.json set `"onboarded": false` (or delete the key), `npm start` → wizard appears instead of the app.
2. Walk all 7 steps: pick Alexa + display name "Nova", confirm OS, allow media, skip voice, watch calibration meter respond to speech, set a hotkey, Finish → app loads; `ui:status.assistant_name` shows "Nova"; settings.json has `wakeWordModel: "alexa_v0.1.onnx"`, `onboarded: true`, the hotkey, and the threshold.
3. Relaunch → straight to the app (no wizard).
4. Settings → Redo setup → wizard returns; Esc → back to app, everything intact (skip writes nothing but `onboarded`).
5. Kill the network → fresh wizard run still completes (voice + calibration degrade with their skip messages; nothing blocks).

- [ ] **Step 6: Commit**

```bash
git add renderer/onboarding.html main.js preload.js renderer/index.html
git commit -m "feat: first-launch onboarding wizard (name, wake word, OS, permissions, voice, calibration, hotkey)"
```

---

### Task 12: Persistence audit + final verification

**Files:**
- Modify: `main.js` (whatever the audit finds), `README.md`, `INSTRUCTIONS.md` (architecture notes)

- [ ] **Step 1: Session-only state audit**

Run: `grep -n "^let \|^const .* = null\|^const .* = false" main.js | head -60` and review each mutable top-level. For each, decide persist / intentionally-session-only (+ add a `// session-only by design:` comment). Known items to check: `overlayMode`, `overlayThreadStart`, `aiStatus`, open-mic runtime state. Expected outcome per spec: engines, model picks, bubble/panel bounds, wake settings, onboarded, osVariant all persist (verified in prior tasks); anything else surprising gets raised to the user before changing.

Also audit mic/camera stream release (spec A6.4): with wake word OFF and no recording active, verify no mic stream is held (Windows mic-in-use indicator off; `WakeWord.stop()` paths stop all tracks — see wakeword.js `stop()`), and the camera light goes off when camera mode closes. Fix any leaked `getUserMedia` streams found in renderer/index.html.

- [ ] **Step 2: Run the automated tests**

Run: `npm test`
Expected: both test files print `all assertions passed`.

- [ ] **Step 3: Full manual checklist (from the spec — all six)**

1. **Fresh machine:** rename `%APPDATA%/Caryl.ai` aside → launch → wizard → complete → app usable online-only, zero downloads. Restore your real dir after.
2. **Upgrade:** with Caryl dir absent and legacy dir present → launch → data migrated, legacy intact.
3. **Engine toggles:** flip each of the four, restart, state restored; offline-with-missing-model shows Download, never silence.
4. **Bubble:** drag → quit → relaunch → exact position (second monitor too if available).
5. **Win10:** `osVariant: "win10"` → solid overlays, no acrylic.
6. **RAM:** re-run the Task 7 PowerShell measurement; record final idle number vs the Task 7 baseline.

- [ ] **Step 4: Update docs**

README.md architecture section: add `lib/engines.js`, `lib/migrate.js`, `lib/downloads.js`, `renderer/onboarding.html` lines; INSTRUCTIONS.md: replace the "AI Mode" walkthrough with the Engines & Models description (four independent toggles + download manager).

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: persistence audit, docs update - Sub-project A (Caryl.ai foundation) complete"
```
