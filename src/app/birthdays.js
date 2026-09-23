// Дни рождения — то же, что «🎂 Дни рождения» в админ-панели бота:
// список (по ближайшим), добавить, удалить. Поздравления рассылает
// сам бот по этой же таблице. /api/birthdays, /api/birthdays/{id}/delete.

import { apiGet, apiPost, openSheet, toast, dialogSkeletonHtml } from "./api.js";
import { esc } from "./utils.js";

const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const TRASH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';

// Сколько дней до ближайшего дня рождения (0 — сегодня). 29 февраля в
// невисокосный год отмечаем 28-го, как делает и бот.
export function daysUntil(month, day, from = new Date()) {
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const at = y => {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return new Date(y, month - 1, month === 2 && day === 29 && !leap ? 28 : day);
  };
  let next = at(today.getFullYear());
  if (next < today) next = at(today.getFullYear() + 1);
  return Math.round((next - today) / 86400000);
}

function whenLabel(n) {
  if (n === 0) return "сегодня";
  if (n === 1) return "завтра";
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? "день" : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "дня" : "дней");
  return `через ${n} ${w}`;
}

function ageLabel(b) {
  if (!b.year) return "";
  const next = new Date();
  next.setDate(next.getDate() + daysUntil(b.month, b.day));
  return `${daysUntil(b.month, b.day) === 0 ? "исполняется" : "исполнится"} ${next.getFullYear() - b.year}`;
}

function rowHtml(b) {
  const n = daysUntil(b.month, b.day);
  return `
    <div class="bd-row${n === 0 ? " today" : ""}">
      <div class="bd-date"><b>${b.day}</b><span>${MONTHS_GEN[b.month - 1].slice(0, 3)}</span></div>
      <div class="bd-main">
        <b>${esc(b.name)}</b>
        <span>${b.day} ${MONTHS_GEN[b.month - 1]}${b.year ? ` ${b.year}` : ""}${ageLabel(b) ? ` · ${ageLabel(b)}` : ""}</span>
      </div>
      <span class="bd-when${n <= 7 ? " soon" : ""}">${whenLabel(n)}</span>
      <button type="button" class="icon-btn bd-del" data-bd-del="${b.id}" title="Удалить" aria-label="Удалить ${esc(b.name)}">${TRASH_ICON}</button>
    </div>`;
}

export async function openBirthdaysSheet(onChange) {
  const overlay = openSheet(`<h2>Дни рождения</h2>${dialogSkeletonHtml(4)}`);
  const sheet = overlay.querySelector(".sheet");
  sheet.classList.add("bd-sheet");

  function render(list) {
    const sorted = list.slice().sort((a, b) => daysUntil(a.month, a.day) - daysUntil(b.month, b.day));
    sheet.innerHTML = `
      <h2>Дни рождения</h2>
      <p class="tn-hint">Бот сам поздравляет команду в день рождения. Ближайшие видны на «Обзоре» и в «Календаре».</p>
      <form class="bd-form" id="bd-form">
        <input id="bd-name" type="text" maxlength="100" placeholder="Имя, например Никита (nikita_dub)" required aria-label="Имя">
        <input id="bd-date" type="date" required aria-label="Дата рождения">
        <label class="bd-noyear"><input type="checkbox" id="bd-noyear"> без года</label>
        <button class="btn primary" type="submit">Добавить</button>
      </form>
      <div class="bd-list">${sorted.length ? sorted.map(rowHtml).join("") : `<div class="no-assignee">Пока никого — добавьте первый день рождения</div>`}</div>
      <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    sheet.querySelector("#bd-form").addEventListener("submit", async e => {
      e.preventDefault();
      const name = sheet.querySelector("#bd-name").value.trim();
      const date = sheet.querySelector("#bd-date").value;
      const m = date.match(/^(\d{4})-(\d\d)-(\d\d)$/);
      if (!name || !m) { toast("Укажите имя и дату.", "error"); return; }
      const noYear = sheet.querySelector("#bd-noyear").checked;
      const btn = e.submitter || sheet.querySelector("#bd-form button");
      btn.disabled = true;
      try {
        const d = await apiPost("/birthdays", { name, month: Number(m[2]), day: Number(m[3]), year: noYear ? null : Number(m[1]) });
        toast(`${name} — добавлено.`);
        render(d.birthdays || []);
        if (onChange) onChange();
      } catch (err) {
        toast(`Не удалось добавить: ${err.message}`, "error");
        btn.disabled = false;
      }
    });
    sheet.querySelectorAll("[data-bd-del]").forEach(b => b.addEventListener("click", async () => {
      const item = list.find(x => String(x.id) === b.dataset.bdDel);
      if (!confirm(`Удалить день рождения «${item ? item.name : ""}»?`)) return;
      b.disabled = true;
      try {
        const d = await apiPost(`/birthdays/${b.dataset.bdDel}/delete`, {});
        render(d.birthdays || []);
        if (onChange) onChange();
      } catch (err) {
        toast(`Не удалось удалить: ${err.message}`, "error");
        b.disabled = false;
      }
    }));
  }

  try {
    const d = await apiGet("/birthdays");
    render(d.birthdays || []);
  } catch (e) {
    sheet.innerHTML = `<h2>Дни рождения</h2><div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  }
}
