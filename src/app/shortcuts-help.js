// Горячие клавиши десктопа — то, чего у Telegram-мини-аппа физически
// нет (там всё через тач/клик), поэтому список специально десктопный:
// переключение вкладок цифрами, командная палитра, поиск, своя
// подсказка по "?" (привычка из Linear/Notion/Superhuman — там это
// тоже "?").
//
// Cmd/Ctrl+1..6 переключают вкладки по позиции в сайдбаре — тот же
// порядок, что и в HTML (#tabstrip .tab-btn), а не хардкод имён: если
// вкладки поменяют местами в разметке, цифры сами поедут вместе с ними.

import { $, $all } from "./utils.js";
import { openSheet } from "./api.js";
import { switchTab } from "./tabs.js";

const GROUPS = [
  {
    title: "Навигация",
    rows: [
      ["Ctrl/Cmd + 1…6", "переключить вкладку"],
      ["Ctrl/Cmd + K", "командная палитра — перейти, найти отчёт, выполнить действие"],
      ["Ctrl/Cmd + F", "поиск по списку (когда открыт «Список»)"],
      ["Esc", "закрыть текущее окно/модалку"],
    ],
  },
  {
    title: "Список отчётов",
    rows: [
      ["Клик по строке", "открыть карточку отчёта"],
      ["Правый клик по строке", "быстрые действия без открытия карточки"],
      ["★ у номера", "добавить/убрать из локального избранного"],
    ],
  },
  {
    title: "Через всё приложение",
    rows: [
      ["Ctrl+Shift+P", "показать/скрыть окно, даже свёрнутое в трей"],
      ["?", "этот список"],
    ],
  },
];

function shortcutsHtml() {
  return `
    <h2>⌨️ Горячие клавиши</h2>
    <div class="shortcuts-list">
      ${GROUPS.map(g => `
        <div class="shortcuts-group">
          <div class="shortcuts-group-title">${g.title}</div>
          ${g.rows.map(([keys, desc]) => `
            <div class="shortcuts-row">
              <span class="shortcuts-keys">${keys.split(" + ").map(k => `<kbd>${k}</kbd>`).join(" <span class=\"shortcuts-plus\">+</span> ")}</span>
              <span class="shortcuts-desc">${desc}</span>
            </div>
          `).join("")}
        </div>
      `).join("")}
    </div>
    <div class="sheet-actions"><button class="btn primary" data-close>Понятно</button></div>
  `;
}

function openShortcutsHelp() {
  const overlay = openSheet(shortcutsHtml());
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
}

document.addEventListener("keydown", e => {
  // "?" — физически Shift+/ на большинстве раскладок; не перехватываем,
  // если фокус в поле ввода (иначе "?" в тексте заметки/поиска открывал
  // бы это окно вместо того, чтобы напечататься) или уже открыта модалка.
  if (e.key !== "?") return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || document.querySelector(".overlay")) return;
  e.preventDefault();
  openShortcutsHelp();
});

// Ctrl/Cmd+1..6 — вкладки по позиции в сайдбаре, тем же способом, что
// командная палитра переключает их по имени.
document.addEventListener("keydown", e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const n = Number(e.key);
  if (!Number.isInteger(n) || n < 1 || n > 9) return;
  const tabs = $all(".tab-btn");
  const btn = tabs[n - 1];
  if (!btn) return;
  e.preventDefault();
  switchTab(btn.dataset.tab);
});

// Значок "?" в шапке — не у всех есть привычка искать шорткаты
// клавишей вслепую, видимая кнопка рядом с остальными в titlebar-right.
const btn = $("#open-shortcuts");
if (btn) btn.addEventListener("click", openShortcutsHelp);
