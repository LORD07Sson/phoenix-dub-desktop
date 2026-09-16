// Светлая/тёмная тема — localStorage, применяется сразу при импорте модуля.

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("phoenix-theme", theme); } catch (_) {}
}

(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("phoenix-theme"); } catch (_) {}
  applyTheme(saved || "dark");
})();

// Смена темы раньше была одним мгновенным щелчком — все цвета разом.
// View Transitions API (Chromium/WebView2 111+, см. build.yml — сборка
// только под windows-latest, там актуальный WebView2) даёт плавный
// crossfade почти бесплатно: браузер сам снимает снимки до/после и
// анимирует переход между ними. Без поддержки — тот же мгновенный
// щелчок, что и раньше, ничего не ломается.
document.querySelector("#theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    applyTheme(next);
    return;
  }
  document.startViewTransition(() => applyTheme(next));
});
