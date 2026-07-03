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
