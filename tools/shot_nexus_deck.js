// tools/shot_nexus_deck.js
// Offscreen-render renderer/nexus-deck.html in Electron and save a PNG.
// Usage: npx electron tools/shot_nexus_deck.js --out=shot.png [--q=focus=CODER] [--w=1600] [--h=900] [--frames=120]
// Forwards page console to stdout so shader/JS errors are visible.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const arg = (k, dflt) => {
  const m = process.argv.find(a => a.startsWith(`--${k}=`));
  return m ? m.split('=').slice(1).join('=') : dflt;
};
const OUT = path.resolve(arg('out', 'nexus-shot.png'));
const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);
const EXTRA = arg('q', '');
const MIN_FRAMES = parseInt(arg('frames', '120'), 10);

app.disableHardwareAcceleration(); // SwiftShader: deterministic headless pixels
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: W, height: H,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  win.webContents.setFrameRate(30);
  win.webContents.on('console-message', (_e, _lvl, msg, line, src) => {
    console.log(`[page] ${msg}${src ? ` (${path.basename(src)}:${line})` : ''}`);
  });
  win.webContents.on('render-process-gone', (_e, d) => { console.error('[page] renderer gone:', d.reason); app.exit(2); });

  const file = path.resolve(__dirname, '..', 'renderer', 'nexus-deck.html');
  const query = EXTRA.includes('noshot=1') ? EXTRA : 'shot=1' + (EXTRA ? `&${EXTRA}` : '');
  await win.loadURL(`file://${file.replace(/\\/g, '/')}?${query}`);

  const t0 = Date.now();
  let frames = 0;
  while (Date.now() - t0 < 45000) {
    await new Promise(r => setTimeout(r, 500));
    try { frames = await win.webContents.executeJavaScript('window.__frames||0'); } catch (_) {}
    if (frames >= MIN_FRAMES) break;
  }
  console.log(`[shot] frames painted: ${frames} in ${Date.now() - t0}ms`);
  if (frames === 0) { console.error('[shot] page never rendered a frame'); app.exit(3); return; }

  const js = arg('js', '');
  if (js) {
    const out = await win.webContents.executeJavaScript(`(function(){ ${js} })()`).catch(e => `JS ERROR: ${e}`);
    if (out !== undefined) console.log('[shot] js →', JSON.stringify(out));
    await new Promise(r => setTimeout(r, parseInt(arg('post', '400'), 10)));
  }

  const img = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, img.toPNG());
  console.log(`[shot] saved ${OUT} (${img.getSize().width}x${img.getSize().height})`);
  app.exit(0);
});
