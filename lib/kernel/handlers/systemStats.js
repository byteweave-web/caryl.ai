// lib/kernel/handlers/systemStats.js
// PURE_LOGIC handler: report machine stats from local reads only (Node os + fs) — no
// external API, no browser. The formatting/assembly is split into pure functions
// (formatBytes / formatUptime / buildPayload) that test deterministically with fixed
// inputs; collect() is the thin impure shell that reads the real machine and feeds them.
// Output is the same {title, rows, accent} payload the overlay card renders.

const os = require('os');
const fs = require('fs');

// Binary-unit byte formatter: 1023 -> "1023 B", 1024 -> "1.0 KB", 8 GiB -> "8.0 GB".
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return Math.round(n) + ' B';
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let val = n / 1024, i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return val.toFixed(1) + ' ' + units[i];
}

// Seconds -> the two most significant units: "45s", "1m 30s", "1h 1m", "1d 1h".
function formatUptime(sec) {
  let s = Math.floor(Number(sec) || 0);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + s + 's';
  return s + 's';
}

function usageRow(label, used, total) {
  const pct = total > 0 ? Math.round((used / total) * 100) : 0;
  return { label, value: formatBytes(used) + ' / ' + formatBytes(total) + ' (' + pct + '%)' };
}

// buildPayload(raw) -> { title, rows:[{label,value}], accent }. Pure.
function buildPayload(raw) {
  raw = raw || {};
  const total = Number(raw.totalMem) || 0;
  const free = Number(raw.freeMem) || 0;
  const rows = [];
  rows.push({ label: 'CPU', value: (raw.cpuCount || 0) + ' × ' + (raw.cpuModel || 'unknown') });
  rows.push(usageRow('Memory', Math.max(0, total - free), total));
  if (raw.disk && Number(raw.disk.total)) {
    const dtotal = Number(raw.disk.total) || 0;
    const dfree = Number(raw.disk.free) || 0;
    rows.push(usageRow('Disk', Math.max(0, dtotal - dfree), dtotal));
  }
  rows.push({ label: 'Uptime', value: formatUptime(raw.uptimeSec) });
  if (raw.platform) rows.push({ label: 'System', value: raw.platform + (raw.release ? ' ' + raw.release : '') });
  return { title: 'System stats', accent: 'blue', rows };
}

// Best-effort free/total for the drive the app runs from. Returns null on any failure
// (older Node without statfsSync, permission error) so the Disk row is simply omitted.
function readDisk() {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const rootPath = process.platform === 'win32' ? (process.cwd().slice(0, 3) || 'C:\\') : '/';
    const st = fs.statfsSync(rootPath);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    if (!total) return null;
    return { total, free };
  } catch (_e) { return null; }
}

// Read the real machine and build the payload.
function collect() {
  const cpus = os.cpus() || [];
  return buildPayload({
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    cpuCount: cpus.length,
    cpuModel: ((cpus[0] && cpus[0].model) || 'unknown').trim(),
    uptimeSec: os.uptime(),
    platform: os.platform(),
    release: os.release(),
    disk: readDisk()
  });
}

// Kernel handler entrypoint. Returns a spoken summary + the overlay payload.
function run(_params) {
  try {
    const payload = collect();
    const find = (l) => { const r = payload.rows.find((x) => x.label === l); return r ? r.value : ''; };
    const speak = 'CPU ' + find('CPU') + '. Memory ' + find('Memory') + '. Up ' + find('Uptime') + '.';
    return { ok: true, speak, overlay: payload };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { formatBytes, formatUptime, buildPayload, collect, run };
