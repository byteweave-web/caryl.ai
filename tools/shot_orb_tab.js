// tools/shot_orb_tab.js
// Offscreen-render renderer/index.html and verify the Nexus deck is wired into
// the Orb tab: loads fully offline (vendored three.js), renders frames, and the
// parent→deck postMessage bridge delivers live state (deck's live.on flips true).
// Usage: npx electron tools/shot_orb_tab.js --out=orb.png
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const arg = (k, dflt) => {
  const m = process.argv.find(a => a.startsWith(`--${k}=`));
  return m ? m.split('=').slice(1).join('=') : dflt;
};
const OUT = path.resolve(arg('out', 'orb-tab-shot.png'));
const W = parseInt(arg('w', '1600'), 10), H = parseInt(arg('h', '900'), 10);

app.disableHardwareAcceleration(); // SwiftShader: deterministic headless pixels
app.commandLine.appendSwitch('disable-web-security'); // allow cross-frame executeJavaScript reads
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: W, height: H,
    webPreferences: {
      offscreen: true, backgroundThrottling: false, webSecurity: false,
      contextIsolation: false, sandbox: false,
      preload: path.join(__dirname, '_orb_probe_preload.js'),
    },
  });
  win.webContents.setFrameRate(30);
  const netHits = [];
  win.webContents.on('console-message', (_e, _lvl, msg, line, src) => {
    console.log(`[page] ${msg}${src ? ` (${path.basename(src)}:${line})` : ''}`);
  });
  // Flag any attempt to reach the network — must be zero for "fully offline".
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => {
    netHits.push(d.url); cb({ cancel: true });
  });

  const file = path.resolve(__dirname, '..', 'renderer', 'index.html');
  await win.loadURL(`file://${file.replace(/\\/g, '/')}`);

  // Poll the embedded deck (its own document) until it has painted frames.
  const probe = `(function(){
    var f=document.getElementById('orb-deck');
    var w=f&&f.contentWindow;
    var n=w&&w.__nexus;
    return {
      hasIframe: !!f,
      deckLoaded: !!n,
      frames: (w&&w.__frames)||0,
      bridgeLive: !!(n&&n.live&&n.live.on),
    };
  })()`;
  let s = {};
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 400));
    try { s = await win.webContents.executeJavaScript(probe); } catch (_) {}
    if (s.deckLoaded && s.frames >= 60) break;
  }
  console.log('[orb] probe:', JSON.stringify(s));

  // Drive a "speaking" pulse through the deck and let it settle for the shot.
  try {
    await win.webContents.executeJavaScript(
      `document.getElementById('orb-deck').contentWindow.__nexus.driveState({speaking:true,level:0.85});0`
    );
  } catch (e) { console.log('[orb] drive err', e); }
  await new Promise(r => setTimeout(r, 900));

  const img = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, img.toPNG());
  console.log(`[orb] saved ${OUT} (${img.getSize().width}x${img.getSize().height})`);
  // Split network hits: the Orb-tab task owns three.js/fonts; onnx/tfjs are
  // separate pre-existing app features (wakeword / vision), reported for info.
  const deckHits = netHits.filter(u => /three|fonts\.g(oogle|static)/i.test(u));
  const otherHits = netHits.filter(u => !/three|fonts\.g(oogle|static)/i.test(u));
  console.log(`[orb] deck/font CDN hits (must be 0): ${deckHits.length}${deckHits.length ? ' → ' + deckHits.join(', ') : ''}`);
  console.log(`[orb] unrelated pre-existing CDN hits: ${otherHits.length}${otherHits.length ? ' → ' + otherHits.map(u => u.replace(/^https?:\/\//, '').split('/')[0]).filter((v, i, a) => a.indexOf(v) === i).join(', ') : ''}`);
  const pass = s.deckLoaded && s.frames >= 60 && deckHits.length === 0 && s.bridgeLive;
  console.log(`[orb] RESULT: ${pass ? 'PASS' : 'FAIL'} (deckLoaded=${s.deckLoaded} frames=${s.frames} bridgeLive=${s.bridgeLive} deckCdn=${deckHits.length})`);
  app.exit(pass ? 0 : 1);
});
