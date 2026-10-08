// Applies the saved theme and text size before first paint (classic script, runs sync).
try {
  var s = JSON.parse(localStorage.getItem('yaad.v1') || '{}').settings || {};
  if (s.theme && s.theme !== 'system') document.documentElement.dataset.theme = s.theme;
  if (s.font) document.documentElement.style.setProperty('--reading-scale', s.font);
} catch (e) {}
