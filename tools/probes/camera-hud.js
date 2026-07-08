(async function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  await sleep(300);
  var out = {};
  out.fns = ['camEnterMonitor', 'expandCamera', 'collapseCamera', 'camExitMonitor']
    .every(function (f) { return typeof window[f] === 'function'; });
  if (!out.fns) return JSON.stringify({ pass: false, detail: out });
  var root = document.documentElement;

  // fake webcam (offscreen harness has none)
  var cv = document.createElement('canvas'); cv.width = 320; cv.height = 180;
  cv.getContext('2d').fillRect(0, 0, 320, 180);
  var stream = cv.captureStream(5);
  _liveStream = stream; // top-level let binding — bare assignment reaches it

  camEnterMonitor(stream);
  await sleep(250);
  var mon = document.getElementById('cam-monitor');
  out.monShown = !!(mon && mon.style.display !== 'none');
  out.monInZone = !!(mon && mon.parentElement && mon.parentElement.classList.contains('slotzone'));
  out.monSlot = mon && mon.dataset.slot;                                        // BR
  out.focusMonitor = root.getAttribute('data-focus');                           // camera
  out.densityMonitor = root.style.getPropertyValue('--glass-density').trim();   // 0.55
  var live = document.getElementById('cam-live');
  out.liveInMonitor = !!(live && live.closest('#cam-monitor'));

  // Watcher honesty: no local vision model in this harness -> the dot must NOT claim watching.
  var dot = document.getElementById('watch-dot');
  out.dotExists = !!dot;
  out.dotNotWatching = !!(dot && !dot.classList.contains('watching'));
  // Mute toggle persists + stamps the dot.
  localStorage.removeItem('sceneWatchMuted');
  toggleSceneWatch();
  out.mutedPersisted = localStorage.getItem('sceneWatchMuted') === '1';
  out.dotMuted = !!(dot && dot.classList.contains('muted'));
  toggleSceneWatch();
  out.unmuted = localStorage.getItem('sceneWatchMuted') === '0';

  expandCamera();
  await sleep(250);
  out.focusFull = root.getAttribute('data-focus');                              // camera-full
  out.densityFull = root.style.getPropertyValue('--glass-density').trim();      // 0.98
  var full = document.getElementById('cam-full');
  out.fullShown = !!(full && full.style.display !== 'none');
  out.liveInStage = !!(live && live.closest('#cam-stage'));

  collapseCamera();
  await sleep(250);
  out.focusBack = root.getAttribute('data-focus');                              // camera
  out.fullHidden = !!(full && full.style.display === 'none');
  out.liveBackInMonitor = !!(live && live.closest('#cam-monitor'));

  camExitMonitor();
  await sleep(150);
  out.focusOrb = root.getAttribute('data-focus');                               // orb
  out.monHidden = !!(mon && mon.style.display === 'none');
  out.claimGone = !((window.Shell.slots.get().placements || {}).camera);
  var live2 = document.getElementById('cam-live');
  out.liveBackInStage = !!(live2 && live2.closest('#cam-stage'));

  try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_e) {}
  _liveStream = null;

  var pass = out.monShown && out.monInZone && out.monSlot === 'BR' &&
             out.focusMonitor === 'camera' && out.densityMonitor === '0.55' &&
             out.liveInMonitor && out.focusFull === 'camera-full' && out.densityFull === '0.98' &&
             out.fullShown && out.liveInStage && out.focusBack === 'camera' && out.fullHidden &&
             out.liveBackInMonitor && out.focusOrb === 'orb' && out.monHidden && out.claimGone &&
             out.dotExists && out.dotNotWatching && out.mutedPersisted && out.dotMuted && out.unmuted &&
             out.liveBackInStage;
  return JSON.stringify({ pass: pass, detail: out });
})()
