// Светлая/тёмная тема — localStorage, применяется сразу при импорте модуля.

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("phoenix-theme", theme); } catch (_) {}
}

// Стиль тёмной темы: "glow" (золотое свечение) или "fire" (огонь).
export function applyLook(look) {
  document.documentElement.dataset.look = look;
  try { localStorage.setItem("phoenix-look", look); } catch (_) {}
}

(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("phoenix-theme"); } catch (_) {}
  applyTheme(saved || "dark");
  // Вариант оформления тёмной темы: "glow" (по умолчанию) или "fire".
  let look = null;
  try { look = localStorage.getItem("phoenix-look"); } catch (_) {}
  document.documentElement.dataset.look = look || "glow";
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
