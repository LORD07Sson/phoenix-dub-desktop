// Плотность таблицы «Список» — обычная/компактная, тот же переключатель,
// что в Linear/Notion/файловых менеджерах. Десктоп даёт для этого
// экранное пространство и настоящую мышь с точным наведением, поэтому
// компактный режим имеет смысл — в мини-аппе с тач-целями такой режим
// был бы просто неудобен, там его нет и не должно быть.

const KEY = "project-density";

export function applyDensity(density) {
  document.documentElement.dataset.density = density;
  try { localStorage.setItem(KEY, density); } catch (_) {}
}

export function currentDensity() {
  try { return localStorage.getItem(KEY) || "comfortable"; } catch (_) { return "comfortable"; }
}

applyDensity(currentDensity());
