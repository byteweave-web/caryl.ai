(async function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  await sleep(300);
  var out = {};
  out.fns = ['camEnterMonitor', 'expandCamera', 'collapseCamera', 'camExitMonitor']
    .every(function (f) { return typeof window[f] === 'function'; });
  if (!out.fns) return JSON.stringify({ pass: false, detail: out });
  var root = document.documentElement;
  localStorage.removeItem('camMonitorBounds'); // deterministic default spawn

  // fake webcam (offscreen harness has none)
  var cv = document.createElement('canvas'); cv.width = 320; cv.height = 180;
  cv.getContext('2d').fillRect(0, 0, 320, 180);
  var stream = cv.captureStream(5);
  _liveStream = stream; // top-level let binding — bare assignment reaches it

  camEnterMonitor(stream);
  await sleep(250);
  var mon = document.getElementById('cam-monitor');
  out.monShown = !!(mon && mon.style.display !== 'none');
  // free-floating panel (weather-board contract): body child, no slot, fixed, resizable
  out.freeFloating = !!(mon && mon.parentElement === document.body && !mon.dataset.slot);
  var cs = getComputedStyle(mon);
  out.fixed = cs.position === 'fixed';
  out.resizable = cs.resize === 'both';
  // default spawn: the BR gutter corner (30px off bottom-right)
  var r0 = mon.getBoundingClientRect();
  out.defaultBR = Math.abs((r0.left + r0.width + 30) - window.innerWidth) <= 2 &&
                  Math.abs((r0.top + r0.height + 30) - window.innerHeight) <= 2;
  // NO engine pull-back at monitor: focus/density untouched
  out.focusStaysOrb = root.getAttribute('data-focus') === 'orb';
  out.densityStill0 = root.style.getPropertyValue('--glass-density').trim() === '0';
  // NO blur behind: even on the frosted (win11) branch the monitor has no backdrop-filter
  var prevOs = root.dataset.os; root.dataset.os = 'win11';
  var mcs = getComputedStyle(mon);
  var bf = mcs.backdropFilter || mcs.webkitBackdropFilter || 'none';
  out.noBackdropBlur = !/blur\(/.test(bf);
  root.dataset.os = prevOs;
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

  // Drag by the header: the monitor follows the pointer and the bounds persist.
  var head = mon.querySelector('.cam-mon-head');
  var hr = head.getBoundingClientRect();
  var x0 = hr.left + hr.width / 2, y0 = hr.top + hr.height / 2;
  function pe(type, x, y) { return new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1 }); }
  head.dispatchEvent(pe('pointerdown', x0, y0));
  head.dispatchEvent(pe('pointermove', x0 - 72, y0 - 46));
  head.dispatchEvent(pe('pointerup', x0 - 72, y0 - 46));
  await sleep(60);
  var r1 = mon.getBoundingClientRect();
  out.dragged = Math.abs(r1.left - (r0.left - 72)) <= 2 && Math.abs(r1.top - (r0.top - 46)) <= 2;
  var saved = null; try { saved = JSON.parse(localStorage.getItem('camMonitorBounds') || 'null'); } catch (_e) {}
  out.boundsSaved = !!(saved && Math.abs(saved.x - r1.left) <= 2 && Math.abs(saved.y - r1.top) <= 2);

  expandCamera();
  await sleep(250);
  out.focusFull = root.getAttribute('data-focus');                              // camera-full
  out.densityFull = root.style.getPropertyValue('--glass-density').trim();      // 0.98
  var full = document.getElementById('cam-full');
  out.fullShown = !!(full && full.style.display !== 'none');
  out.liveInStage = !!(live && live.closest('#cam-stage'));

  collapseCamera();
  await sleep(250);
  out.focusRestored = root.getAttribute('data-focus');                          // orb (pre-expand focus)
  out.fullHidden = !!(full && full.style.display === 'none');
  out.liveBackInMonitor = !!(live && live.closest('#cam-monitor'));

  camExitMonitor();
  await sleep(150);
  out.focusOrb = root.getAttribute('data-focus');                               // orb
  out.monHidden = !!(mon && mon.style.display === 'none');
  var live2 = document.getElementById('cam-live');
  out.liveBackInStage = !!(live2 && live2.closest('#cam-stage'));

  try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_e) {}
  _liveStream = null;
  localStorage.removeItem('camMonitorBounds');

  var pass = out.monShown && out.freeFloating && out.fixed && out.resizable && out.defaultBR &&
             out.focusStaysOrb && out.densityStill0 && out.noBackdropBlur && out.liveInMonitor &&
             out.dotExists && out.dotNotWatching && out.mutedPersisted && out.dotMuted && out.unmuted &&
             out.dragged && out.boundsSaved &&
             out.focusFull === 'camera-full' && out.densityFull === '0.98' && out.fullShown && out.liveInStage &&
             out.focusRestored === 'orb' && out.fullHidden && out.liveBackInMonitor &&
             out.focusOrb === 'orb' && out.monHidden && out.liveBackInStage;
  return JSON.stringify({ pass: pass, detail: out });
})()
