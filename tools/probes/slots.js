(async function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  await sleep(300); // DOMContentLoaded work (the dock claim) has run by now
  var out = {};
  var S = window.Shell && window.Shell.slots;
  out.api = !!(S && S.claim && S.release && S.external && S.get);
  if (!out.api) return JSON.stringify({ pass: false, detail: out });

  // the chat dock is a citizen already (claimed on DOMContentLoaded, BL)
  var dock = document.getElementById('chat-dock');
  out.dockSlot = dock && dock.dataset.slot;
  out.dockInZone = !!(dock && dock.parentElement && dock.parentElement.id === 'slot-BL');

  // fake camera element: prefers BR, accepts TR/TL
  var cam = document.createElement('div'); cam.id = 'probe-cam'; cam.textContent = 'CAM';
  S.claim('probe-cam', { priority: 50, slots: ['BR', 'TR', 'TL'], el: cam });
  out.camSolo = cam.dataset.slot + ':' + cam.classList.contains('ghosted'); // "BR:false"

  // higher-priority element takes BR -> camera re-anchors to TR
  var chip = document.createElement('div'); chip.id = 'probe-chip'; chip.textContent = 'CHIP';
  S.claim('probe-chip', { priority: 90, slots: ['BR'], el: chip });
  out.chipSlot = chip.dataset.slot;                       // BR
  out.camReanchored = cam.dataset.slot;                   // TR
  out.camInTR = !!(cam.parentElement && cam.parentElement.id === 'slot-TR');

  // satellites cover TR and TL -> camera has nowhere -> ghosts at its preferred BR
  S.external(['TR', 'TL']);
  out.camGhost = cam.classList.contains('ghosted');
  out.camGhostSlot = cam.dataset.slot;                    // BR (in place, under the chip)
  out.zoneHasGhost = document.getElementById('slot-BR').classList.contains('has-ghost');
  out.externalEcho = (S.get().external || []).join(',');  // "TR,TL"

  // satellites leave -> camera un-ghosts back to TR
  S.external([]);
  out.camBack = cam.dataset.slot + ':' + cam.classList.contains('ghosted'); // "TR:false"

  // chip releases -> camera returns to BR; the chip element left the zones
  S.release('probe-chip');
  out.camHome = cam.dataset.slot;                          // BR
  out.chipGone = !chip.parentElement;

  S.release('probe-cam');

  var pass = out.dockSlot === 'BL' && out.dockInZone &&
             out.camSolo === 'BR:false' && out.chipSlot === 'BR' &&
             out.camReanchored === 'TR' && out.camInTR === true &&
             out.camGhost === true && out.camGhostSlot === 'BR' && out.zoneHasGhost === true &&
             out.externalEcho === 'TR,TL' &&
             out.camBack === 'TR:false' && out.camHome === 'BR' && out.chipGone === true;
  return JSON.stringify({ pass: pass, detail: out });
})()
