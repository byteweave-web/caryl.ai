// tools/probe_shell.js
// Offscreen-load renderer/index.html and run a probe file against it. A probe is an IIFE
// string returning JSON.stringify({pass, detail}). Exit 0 on pass, 1 on fail.
// Usage: npx electron tools/probe_shell.js --probe=tools/probes/material.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const m = process.argv.find(a => a.startsWith(`--${k}=`)); return m ? m.split('=').slice(1).join('=') : d; };
const PROBE = path.resolve(arg('probe', ''));
const WAIT = parseInt(arg('wait', '1400'), 10);
const FILE = arg('file', 'index.html');   // renderer-relative page to load (satellites etc.)

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-web-security');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1080, height: 760,
    webPreferences: {
      offscreen: true, backgroundThrottling: false, webSecurity: false,
      contextIsolation: false, sandbox: false,
      preload: path.join(__dirname, '_shell_probe_preload.js'),
    },
  });
  win.webContents.on('console-message', (_e, _l, msg, line, src) => {
    if (/probe|shell|error/i.test(msg)) console.log(`[page] ${msg}${src ? ` (${path.basename(src)}:${line})` : ''}`);
  });

  const file = path.resolve(__dirname, '..', 'renderer', FILE);
  await win.loadURL('file://' + file.replace(/\\/g, '/'));
  await new Promise(r => setTimeout(r, WAIT));

  let out = { pass: false, detail: { error: 'probe threw' } };
  try {
    const body = fs.readFileSync(PROBE, 'utf8');
    const res = await win.webContents.executeJavaScript(body);
    out = JSON.parse(res);
  } catch (e) { out.detail = { error: String(e && e.message || e) }; }

  console.log('\n===== PROBE: ' + path.basename(PROBE) + ' =====');
  console.log(JSON.stringify(out.detail, null, 2));
  console.log('RESULT: ' + (out.pass ? 'PASS' : 'FAIL'));
  app.exit(out.pass ? 0 : 1);
});
