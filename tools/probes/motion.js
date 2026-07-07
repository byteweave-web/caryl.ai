(function () {
  var root = document.documentElement;
  var out = { steps: {} };

  // Preconditions
  out.steps.hasShell = typeof window.Shell === 'object' && typeof window.Shell.setFocus === 'function';
  if (!out.steps.hasShell) return JSON.stringify({ pass: false, detail: out });

  // Open Chat -> focus-depth target 1, chat layer active + glass, engine defocused.
  window.Shell.setFocus('chat');
  var chat = document.getElementById('view-chat');
  out.steps.focusDepthTarget = root.style.getPropertyValue('--focus-depth').trim();
  out.steps.chatActive = chat && chat.classList.contains('active');
  out.steps.chatIsGlass = chat && chat.classList.contains('glass');

  // Composer must remain the top hit-test target (regression guard for the cdm-panel bug).
  var send = document.querySelector('.composer .send');
  var input = document.getElementById('chat-input');
  var sr = send && send.getBoundingClientRect();
  var topSend = send && document.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2);
  out.steps.sendClickable = !!(send && (topSend === send || send.contains(topSend)));
  var ir = input && input.getBoundingClientRect();
  var topIn = input && document.elementFromPoint(ir.left + 20, ir.top + ir.height / 2);
  out.steps.inputClickable = !!(input && (topIn === input || input.contains(topIn)));
  out.steps.topSend = topSend && (topSend.tagName + (topSend.className ? '.' + String(topSend.className).split(' ').join('.') : ''));

  // Return to Orb -> focus-depth target 0.
  window.Shell.setFocus('orb');
  out.steps.focusDepthBack = root.style.getPropertyValue('--focus-depth').trim();

  var pass = out.steps.focusDepthTarget === '1' && out.steps.chatActive && out.steps.chatIsGlass &&
             out.steps.sendClickable && out.steps.inputClickable && out.steps.focusDepthBack === '0';
  return JSON.stringify({ pass: pass, detail: out });
})()
