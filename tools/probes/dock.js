(function () {
  var out = {};
  if (!window.Shell || typeof renderActs !== 'function') return JSON.stringify({ pass: false, detail: { noShellOrRender: true } });
  var acts = [{ kind: 'heard', text: 'what time is it', time: '10:00' }, { kind: 'said', text: 'It is ten past.', time: '10:00' }];

  // Focus the Orb and render an exchange -> the dock should show it in the periphery.
  window.Shell.setFocus('orb');
  renderActs(acts);
  var dock = document.getElementById('chat-dock');
  out.dockExists = !!dock;
  if (!dock) return JSON.stringify({ pass: false, detail: out });
  out.onOrb_class = dock.className;
  out.onOrb_text = dock.textContent;
  var onOrb = dock.classList.contains('on') && /ten past/i.test(dock.textContent) && /caryl/i.test(dock.textContent);

  // Enter Chat -> the dock retracts (focus-driven via the shell:focus event).
  window.Shell.setFocus('chat');
  out.inChat_class = dock.className;
  var offChat = !dock.classList.contains('on');

  return JSON.stringify({ pass: onOrb && offChat, detail: out });
})()
