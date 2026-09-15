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

document.querySelector("#theme-toggle").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  applyTheme(cur);
});
