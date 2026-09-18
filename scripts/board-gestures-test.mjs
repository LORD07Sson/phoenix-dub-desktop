// Проверка жестов доски на СОБРАННОМ бандле (как и verify-modules.mjs —
// исходники с бэйр-спецификаторами и JSX сам Node не резолвит):
//
//   npm run build && npm run test:board
//
// Ловит ровно то, что глазами на сборочном раннере не проверить, а
// руками — только на устройстве с сенсорным экраном: какой жест чем
// становится. Состояние в wireCardDrag (board.js) ветвится на три
// режима (pending/pan/card) и легко ломается «безобидной» правкой —
// например, так, что мышь перестанет переносить карточки между
// колонками, а это главный жест доски.
//
// jsdom не реализует pointer capture, elementFromPoint и прокрутку —
// всё это подставляется заглушками ниже; проверяется логика
// обработчиков, а не движок браузера.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { pathToFileURL } from "node:url";
import path from "node:path";

const distDir = path.resolve(import.meta.dirname, "..", "dist");
const html = readFileSync(path.join(distDir, "index.html"), "utf8");
const entry = path.join(distDir, html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)[1].replace(/^\.\//, ""));

const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window;
const set = (n, v) => Object.defineProperty(globalThis, n, { value: v, writable: true, configurable: true });
for (const n of ["window", "document", "localStorage", "navigator", "Image", "MutationObserver", "requestAnimationFrame", "CustomEvent", "Event", "getComputedStyle"]) set(n, w[n]);
set("requestAnimationFrame", w.requestAnimationFrame || (cb => setTimeout(cb, 0)));

const BOARD = {
  statuses: [
    { status: "working", label: "В работе", total: 2, has_more: false, reports: [
      { public_id: "R-1", title: "Серия 1", priority: "normal", deadline: null, assignees: [] },
      { public_id: "R-2", title: "Серия 2", priority: "high", deadline: null, assignees: [] }] },
    { status: "review", label: "На проверке", total: 0, has_more: false, reports: [] },
  ],
};
const calls = [];
set("fetch", async (url, opts) => {
  const u = String(url);
  calls.push({ url: u, method: (opts && opts.method) || "GET", body: opts && opts.body });
  const body = u.includes("/board") ? BOARD
    : u.includes("/whoami") ? { telegram_id: 1, is_admin: true }
    : u.includes("/me") ? { telegram_id: 1, name: "Тест", is_developer: false, reports: [], badges: [] }
    : u.includes("/assignable-users") ? { users: [] }
    : {};
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
});
// Раскладку доски (сортировка, метрики колонок) считает Rust —
// board_layout в board.rs, там же её и тесты. Здесь проверяются жесты,
// поэтому заглушка отдаёт пересказ входа один в один: порядок карточек
// остаётся тем же, что прислал «сервер», а колонка получает ровно те
// поля, которые читает рендер.
const layoutStub = ({ columns }) => ({
  filteredOut: 0,
  totalOverdue: 0,
  totalStale: 0,
  columns: columns.map(c => ({
    status: c.status, label: c.label, total: c.total, hasMore: c.has_more,
    shown: c.reports.length, overdue: 0, unassigned: 0, stale: 0,
    avgAgeDays: null, wipLimit: null, overWip: false,
    cards: c.reports.map(r => ({
      publicId: r.public_id, title: r.title, priority: r.priority, deadline: r.deadline,
      assignees: r.assignees, daysLeft: null, overdue: false, ageDays: null,
      stale: false, unassigned: !r.assignees.length, heat: 0,
    })),
  })),
});

w.__TAURI_INTERNALS__ = {
  invoke: async (cmd, args) => (
    cmd === "plugin:event|listen" ? 0
      : cmd === "token_load" ? "dsk_test"
        : cmd === "board_layout" ? layoutStub(args)
          : null),
  transformCallback: () => 0, unregisterCallback: () => {}, convertFileSrc: p => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
};

await import(pathToFileURL(entry).href);
await new Promise(r => setTimeout(r, 300));

// Переключаемся на доску
document.querySelector('.tab-btn[data-tab="board"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
await new Promise(r => setTimeout(r, 300));

const board = document.querySelector(".board");
const cards = document.querySelectorAll(".board-card");
if (!board || cards.length !== 2) { console.error("ДОСКА НЕ ОТРИСОВАЛАСЬ:", !!board, cards.length); process.exit(1); }

// jsdom не реализует pointer capture и прокрутку — подставляем минимум
for (const el of [board, ...cards]) {
  el.setPointerCapture = () => {}; el.hasPointerCapture = () => true; el.releasePointerCapture = () => {};
}
// jsdom не умеет elementFromPoint — подставляем, по умолчанию «под курсором ничего»
let underPoint = null;
document.elementFromPoint = () => underPoint;

let scrollLeft = 0;
Object.defineProperty(board, "scrollLeft", { get: () => scrollLeft, set: v => { scrollLeft = v; }, configurable: true });

function pointer(el, type, opts) {
  const e = new w.Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { pointerId: 1, button: 0, buttons: 1, pointerType: "touch", clientX: 0, clientY: 0, ...opts });
  el.dispatchEvent(e);
}

const results = [];
const card = cards[0];

// 1. Палец: провёл по карточке -> доска прокрутилась, переноса нет
scrollLeft = 0;
pointer(card, "pointerdown", { clientX: 200, clientY: 100 });
pointer(card, "pointermove", { clientX: 140, clientY: 104 });
pointer(card, "pointermove", { clientX: 120, clientY: 104 });
const pannedBy = scrollLeft;
const ghostWhilePan = document.querySelector(".board-card-ghost");
pointer(card, "pointerup", { clientX: 120, clientY: 104 });
results.push(["палец ведёт по карточке -> доска едет", pannedBy === 80, `scrollLeft=${pannedBy}, ожидали 80`]);
results.push(["палец ведёт по карточке -> карточка НЕ тащится", !ghostWhilePan, ghostWhilePan ? "появился призрак" : "призрака нет"]);

// 2. Палец: подержал на месте -> начался перенос карточки
scrollLeft = 0;
pointer(card, "pointerdown", { clientX: 200, clientY: 100 });
await new Promise(r => setTimeout(r, 420));
const ghostAfterHold = document.querySelector(".board-card-ghost");
pointer(card, "pointermove", { clientX: 210, clientY: 130 });
const scrollAfterHold = scrollLeft;
pointer(card, "pointerup", { clientX: 210, clientY: 130 });
results.push(["палец удержал 350мс -> карточка поднялась", !!ghostAfterHold, ghostAfterHold ? "призрак есть" : "призрака нет"]);
results.push(["во время переноса доска НЕ едет", scrollAfterHold === 0, `scrollLeft=${scrollAfterHold}`]);
results.push(["после переноса призрак убран", !document.querySelector(".board-card-ghost"), ""]);

// 3. Мышь: поведение не изменилось — сразу перенос карточки
scrollLeft = 0;
pointer(card, "pointerdown", { clientX: 200, clientY: 100, pointerType: "mouse" });
pointer(card, "pointermove", { clientX: 140, clientY: 104, pointerType: "mouse" });
const ghostMouse = document.querySelector(".board-card-ghost");
const scrollMouse = scrollLeft;
pointer(card, "pointerup", { clientX: 140, clientY: 104, pointerType: "mouse" });
results.push(["мышь тянет карточку (как раньше)", !!ghostMouse, ghostMouse ? "призрак есть" : "призрака нет"]);
results.push(["мышь на карточке НЕ прокручивает доску", scrollMouse === 0, `scrollLeft=${scrollMouse}`]);

// 4. Пустое место доски — прокрутка и пальцем, и мышью (wireBoardScroll)
for (const pt of ["touch", "mouse"]) {
  scrollLeft = 0;
  pointer(board, "pointerdown", { clientX: 300, clientY: 400, pointerType: pt });
  pointer(board, "pointermove", { clientX: 250, clientY: 400, pointerType: pt });
  const v = scrollLeft;
  pointer(board, "pointerup", { clientX: 250, clientY: 400, pointerType: pt });
  results.push([`пустое место доски (${pt}) -> прокрутка`, v === 50, `scrollLeft=${v}, ожидали 50`]);
}

// 5. Мышь: перенос карточки в соседнюю колонку по-прежнему шлёт статус
underPoint = document.querySelectorAll(".board-col")[1];
calls.length = 0;
pointer(card, "pointerdown", { clientX: 200, clientY: 100, pointerType: "mouse" });
pointer(card, "pointermove", { clientX: 400, clientY: 110, pointerType: "mouse" });
pointer(card, "pointerup", { clientX: 400, clientY: 110, pointerType: "mouse" });
await new Promise(r => setTimeout(r, 150));
const statusCall = calls.find(c => c.method === "POST" && c.url.includes("/report/R-1/status"));
results.push(["мышь: перенос в другую колонку шлёт статус", !!statusCall && JSON.parse(statusCall.body).status === "review",
  statusCall ? `тело=${statusCall.body}` : `запросов статуса нет (${calls.map(c => c.method + " " + c.url).join(", ")})`]);
underPoint = null;

let bad = 0;
for (const [name, ok, info] of results) { if (!ok) bad++; console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : "  — " + info}`); }
console.log(bad ? `\nПРОВАЛЕНО: ${bad} из ${results.length}` : `\nВсе ${results.length} проверок прошли`);
process.exit(bad ? 1 : 0);
