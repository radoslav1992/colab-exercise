// Applies the theme somebody chose (src/theme.ts) before the page is painted. Without a choice the
// style sheet follows the system. Loaded as a file because the Content-Security-Policy allows no
// inline scripts.
try {
  var theme = localStorage.getItem('notebook-lab:theme')
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
} catch (e) {
  // Storage is blocked: the page follows the system.
}
