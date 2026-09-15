// Проверка заметок с тайм-кодом на СОБРАННОМ бандле:
//
//   npm run build && npm run test:notes
//
// Время заметки хранится префиксом «[4:12] » в самом тексте — отдельного
// поля под него в API нет (см. docs/API.md). Значит разбор и сборка этой
// строки и есть вся фича: ошибка в регулярке не уронит ничего, просто
// тайм-код перестанет отделяться от текста, и заметка тихо превратится в
// обычную. Поэтому проверяются конкретные строки в обе стороны.

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { pathToFileURL } from "node:url";
import path from "node:path";

const distDir = path.resolve(import.meta.dirname, "..", "dist");
const html = readFileSync(path.join(distDir, "index.html"), "utf8");
const entry = path.join(distDir, html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)[1].replace(/^\.\//, ""));

const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window;
const setGlobal = (n, v) => Object.defineProperty(globalThis, n, { value: v, writable: true, configurable: true });
for (const n of ["window", "document", "localStorage", "navigator", "Image", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) setGlobal(n, w[n]);
setGlobal("requestAnimationFrame", w.requestAnimationFrame || (cb => setTimeout(cb, 0)));
document.elementFromPoint = () => null;

const REPORT = {
  public_id: "R-000059", title: "Кагуя — 12", status: "review", status_label: "На проверке",
  priority: "normal", priority_label: "Обычный", deadline: null, created_at: "2026-09-10 10:00:00",
  author: { first_name: "LORD_07" }, assignees: [], pipeline: [],
};
let NOTES = {
  notes: [
    { author: "режиссёр", created_at: "2026-09-14 10:00:00", text: "[11:48] клиппинг на крике" },
    { author: "режиссёр", created_at: "2026-09-14 11:00:00", text: "[4:12] шум на вдохе" },
    { author: "LORD_07", created_at: "2026-09-14 12:00:00", text: "без времени, просто мысль" },
  ],
};

const posted = [];
setGlobal("fetch", async (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || "GET";
  if (method === "POST") posted.push({ url: u, body: JSON.parse(opts.body || "{}") });
  let body = {};
  if (u.includes("/notes")) body = method === "POST" ? { ok: true } : NOTES;
  else if (u.includes("/checklist")) body = { items: [] };
  else if (u.includes("/files")) body = { files: [] };
  else if (u.includes("/meta")) body = { roles: ["Звукореж"] };
  else if (u.includes("/assignable-users")) body = { users: [] };
  else if (u.includes("/reports")) body = { reports: [{ ...REPORT, assignees: [] }], total: 1 };
  else if (/\/report\/R-000059(\?|$)/.test(u)) body = REPORT;
  else if (u.includes("/whoami")) body = { telegram_id: 1, is_admin: true };
  else if (u.includes("/me")) body = { telegram_id: 1, name: "LORD_07", badges: [], reports: [], role_breakdown: [] };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
});

const QC_REPORT = {
  duration: 700, peak_dbfs: -0.1, rms_dbfs: -14.2, passed: false,
  checks: [
    { key: "peak", label: "Пиковый уровень", requirement: "≤ -1.0 дБФС", actual: "-0.1", ok: false },
    { key: "clipping", label: "Клиппинг", requirement: "нет", actual: "1 уч.", ok: false },
  ],
  findings: [
    { kind: "clipping", start: 252, end: 253, severity: "error", message: "Клиппинг — сигнал упирается в потолок шкалы." },
    { kind: "silence", start: 708, end: 711, severity: "warn", message: "Пауза без звука 3.0 с." },
  ],
};
w.__TAURI_INTERNALS__ = {
  invoke: async (cmd) => {
    if (cmd === "token_load") return "dsk_test";
    if (cmd === "plugin:dialog|open") return "/tmp/ep12.wav";
    if (cmd === "qc_analyze") return QC_REPORT;
    return null;
  },
  transformCallback: () => 0, unregisterCallback: () => {}, convertFileSrc: p => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
};

await import(pathToFileURL(entry).href);
await new Promise(r => setTimeout(r, 300));

const results = [];
const check = (name, ok, info) => results.push([name, ok, info || ""]);
const click = el => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
const wait = (ms = 200) => new Promise(r => setTimeout(r, ms));

document.querySelector('.tab-btn[data-tab="list"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
await wait(300);
const row = document.querySelector("#reports-body tr");
if (!row) { console.error("список не отрисовался"); process.exit(1); }
click(row);
await wait(400);

const sheet = document.querySelector(".overlay .sheet");
const noteItems = () => Array.from(sheet.querySelectorAll(".note-item"));

const times = noteItems().map(el => { const t = el.querySelector(".note-time"); return t ? t.textContent : null; });
check("тайм-код вынесен из текста в метку", times[0] === "11:48" && times[1] === "4:12" && times[2] === null, JSON.stringify(times));

const firstBody = noteItems()[0].querySelector(".note-body span:last-child").textContent.trim();
check("из текста заметки префикс убран", firstBody === "клиппинг на крике", firstBody);

const plain = noteItems()[2].querySelector(".note-body span:last-child").textContent.trim();
check("заметка без времени не тронута", plain === "без времени, просто мысль", plain);

const sortBtn = sheet.querySelector("#notes-sort");
check("переключатель порядка появился (2+ заметки со временем)", !!sortBtn, "");
if (sortBtn) {
  click(sortBtn);
  await wait(400);
  const after = Array.from(document.querySelector(".overlay .sheet").querySelectorAll(".note-time")).map(el => el.textContent);
  check("по тайм-коду: 4:12 раньше 11:48", after[0] === "4:12" && after[1] === "11:48", JSON.stringify(after));
}

const sheet2 = document.querySelector(".overlay .sheet");
posted.length = 0;
sheet2.querySelector("#note-time").value = "0:45";
sheet2.querySelector("#note-new").value = "переозвучить фразу";
click(sheet2.querySelector("#note-add"));
await wait(300);
const withTime = posted.find(p => p.url.includes("/notes"));
check("заметка уходит с префиксом времени",
  withTime && withTime.body.text === "[0:45] переозвучить фразу",
  withTime ? JSON.stringify(withTime.body) : "POST не ушёл");

const sheet3 = document.querySelector(".overlay .sheet");
posted.length = 0;
sheet3.querySelector("#note-time").value = "25";
sheet3.querySelector("#note-new").value = "мусорное время";
click(sheet3.querySelector("#note-add"));
await wait(200);
check("кривое время не отправляется", posted.length === 0, `ушло запросов: ${posted.length}`);
check("про кривое время сказано вслух", !!document.querySelector("#toast-root .toast"), "тоста нет");

const sheet4 = document.querySelector(".overlay .sheet");
sheet4.querySelector("#note-time").value = "";
sheet4.querySelector("#note-new").value = "";
click(sheet4.querySelector("#btn-qc-track"));
await wait(400);
const verdict = document.querySelector(".overlay .qc-verdict");
check("QC из карточки показывает вердикт", verdict && verdict.classList.contains("bad") && /На доработку/.test(verdict.textContent),
  verdict ? verdict.textContent.trim() : "нет блока вердикта");
const qcBtn = Array.from(document.querySelectorAll(".overlay .btn")).find(b => /В заметки отчёта/.test(b.textContent));
check("после QC из карточки есть кнопка «в заметки»", !!qcBtn, "");
if (qcBtn) {
  posted.length = 0;
  click(qcBtn);
  await wait(500);
  const texts = posted.filter(p => p.url.includes("/notes")).map(p => p.body.text);
  check("находки уехали в заметки с временем начала",
    texts.length === 2 && texts[0].startsWith("[4:12] ") && texts[1].startsWith("[11:48] "),
    JSON.stringify(texts));
}

let bad = 0;
for (const [name, ok, info] of results) { if (!ok) bad++; console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : "  — " + info}`); }
console.log(bad ? `\nПРОВАЛЕНО: ${bad} из ${results.length}` : `\nВсе ${results.length} проверок прошли`);
process.exit(bad ? 1 : 0);
