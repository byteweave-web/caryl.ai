(async function () {
  // The type ramp's real faces must LOAD (not merely be declared). load() with sample
  // text defeats unicode-range lazy-loading; check() then reports the truth.
  var out = {};
  try {
    await Promise.all([
      document.fonts.load('12px "IBM Plex Mono"', 'Ag14:32'),
      document.fonts.load('14px "IBM Plex Sans"', 'Ag prose'),
      document.fonts.load('600 14px "IBM Plex Sans"', 'Ag bold'),
      document.fonts.load('300 30px "Big Shoulders Display"', 'AG42'),
    ]);
  } catch (e) { out.loadErr = String(e); }
  out.mono = document.fonts.check('12px "IBM Plex Mono"', 'Ag');
  out.read = document.fonts.check('14px "IBM Plex Sans"', 'Ag');
  out.read600 = document.fonts.check('600 14px "IBM Plex Sans"', 'Ag');
  out.disp = document.fonts.check('300 30px "Big Shoulders Display"', 'AG');
  var pass = out.mono && out.read && out.read600 && out.disp;
  return JSON.stringify({ pass: pass, detail: out });
})()
