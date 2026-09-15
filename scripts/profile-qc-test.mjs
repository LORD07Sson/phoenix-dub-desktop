// Проверка вкладки «Я» и пакетного QC на СОБРАННОМ бандле — тот же
// приём, что в board-gestures-test.mjs:
//
//   npm run build && npm run test:profile
//
// Обе фичи целиком построены на данных, которые сервер уже отдаёт, и
// ломаются молча: прогресс наград или порог кольца легко посчитать не от
// того числа, и на экране всё равно будет «какая-то полоска». Поэтому
// проверяются конкретные значения, а не факт отрисовки.

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

const ME = {
  telegram_id: 7269587205,
  internal_id: 1,
  name: "LORD_07",
  username: "by_lord07",
  role: "Тайпсеттер",
  is_developer: true,
  created_at: "2026-05-18 00:00:00",
  member_since_days: 120,
  studio_rank: { place: 1, total: 1 },
  status_text: "Тестировщик тестирует.",
  bio: "",
  assigned: 0,
  overdue: 0,
  avg_days: 2.7,
  on_time_pct: null,
  completed_total: 1,
  completed_week: 1,
  completed_month: 1,
  monthly_goal: null,
  reports: [],
  role_breakdown: [],
  team: { count: 17, preview: [{ telegram_id: 2, name: "ALUCARD" }] },
  badges: [
    { id: 1, icon: "🔥", label: "Феникс недели", rarity: "epic", unlocked: true },
    { id: 2, icon: "🌱", label: "Первый отчёт", rarity: "common", unlocked: true },
    { id: 3, icon: "🏆", label: "50+ закрыто", rarity: "legendary", unlocked: false, current: 1, target: 50 },
    { id: 4, icon: "⏱", label: "90%+ вовремя", rarity: "rare", unlocked: false },
  ],
};

const UNASSIGNED = {
  total: 3,
  reports: [
    { public_id: "R-000070", title: "Соло Леве — 4", status: "draft", deadline: "2026-09-01" },
    { public_id: "R-000071", title: "Соло Леве — 5", status: "draft", deadline: null },
    { public_id: "R-000072", title: "Соло Леве — 6", status: "draft", deadline: null },
  ],
};

setGlobal("fetch", async (url) => {
  const u = String(url);
  let body = {};
  if (u.includes("/overview/monthly-top")) body = { top: [{ telegram_id: 1, name: "LORD_07", completed: 5 }, { telegram_id: 2, name: "ALUCARD", completed: 3 }] };
  else if (u.includes("/me")) body = ME;
  else if (u.includes("unassigned=1")) body = UNASSIGNED;
  else if (u.includes("/reports")) body = { reports: [], total: 0 };
  else if (u.includes("/whoami")) body = { telegram_id: ME.telegram_id, is_admin: true };
  else if (u.includes("/assignable-users")) body = { users: [] };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
});

// checks/passed приходят из Rust (build_checks в audio_qc.rs) — стабы
// повторяют форму настоящего ответа.
const CLIPPED = {
  duration: 62.5, peak_dbfs: -0.1, rms_dbfs: -14.2, passed: false,
  checks: [
    { key: "peak", label: "Пиковый уровень", requirement: "≤ -1.0 дБФС", actual: "-0.1", ok: false },
    { key: "rms", label: "Средняя громкость", requirement: "≥ -38 дБФС", actual: "-14.2", ok: true },
    { key: "clipping", label: "Клиппинг", requirement: "нет", actual: "1 уч.", ok: false },
    { key: "pauses", label: "Паузы длиннее 1.2 с", requirement: "нет", actual: "1", ok: false },
  ],
  findings: [
    { kind: "clipping", start: 3.2, end: 3.6, severity: "error", message: "Клиппинг — сигнал упирается в потолок шкалы." },
    { kind: "silence", start: 40, end: 43, severity: "warn", message: "Пауза без звука 3.0 с." },
  ],
};
const CLEAN = {
  duration: 58.0, peak_dbfs: -3.8, rms_dbfs: -18.1, findings: [], passed: true,
  checks: [
    { key: "peak", label: "Пиковый уровень", requirement: "≤ -1.0 дБФС", actual: "-3.8", ok: true },
    { key: "rms", label: "Средняя громкость", requirement: "≥ -38 дБФС", actual: "-18.1", ok: true },
    { key: "clipping", label: "Клиппинг", requirement: "нет", actual: "нет", ok: true },
    { key: "pauses", label: "Паузы длиннее 1.2 с", requirement: "нет", actual: "0", ok: true },
  ],
};

let qcCalls = 0;
w.__TAURI_INTERNALS__ = {
  invoke: async (cmd, args) => {
    if (cmd === "token_load") return "dsk_test";
    if (cmd === "plugin:dialog|open") return ["/tmp/ep12_kaguya.wav", "/tmp/ep12_fujiwara.wav"];
    if (cmd === "qc_analyze") {
      qcCalls++;
      return String(args.path).includes("kaguya") ? CLIPPED : CLEAN;
    }
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

document.querySelector('.tab-btn[data-tab="profile"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
await new Promise(r => setTimeout(r, 300));

const profile = document.querySelector("#profile-body");

const rank = profile.querySelector(".rank-tag");
check("«#1 из 1» не показывается", !rank, rank ? `показан: ${rank.textContent.trim()}` : "");

const tenureLbl = profile.querySelector(".tenure-lbl");
const tenureText = tenureLbl ? tenureLbl.textContent.replace(/\s+/g, " ").trim() : "";
check("стаж: тир и остаток до следующего кольца",
  /Бронза/.test(tenureText) && /120 дней/.test(tenureText) && /60 дней до «Серебро»/.test(tenureText),
  tenureText);
const fill = profile.querySelector(".tenure-track i");
check("полоска стажа — 60% между 30 и 180", fill && fill.style.width === "60%", fill ? fill.style.width : "нет полоски");

const chips = Array.from(profile.querySelectorAll(".badge-chip")).map(el => el.textContent.trim());
check("полученные награды — чипами", chips.length === 2 && chips.some(t => t.includes("Феникс недели")), chips.join(" | "));

const todos = Array.from(profile.querySelectorAll(".badge-todo")).map(el => el.textContent.replace(/\s+/g, " ").trim());
check("неполученная награда с прогрессом", todos.some(t => t.includes("50+ закрыто") && t.includes("1 / 50")), todos.join(" | "));
check("награда без target — «нет данных»", todos.some(t => t.includes("90%+ вовремя") && t.includes("нет данных")), todos.join(" | "));
const todoFill = profile.querySelector(".badge-todo .badge-track i");
check("полоска награды — 2% (1 из 50)", todoFill && todoFill.style.width === "2%", todoFill ? todoFill.style.width : "нет полоски");

const idle = profile.querySelector("#idle-slot");
const idleText = idle ? idle.querySelector(".d").textContent.replace(/\s+/g, " ").trim() : "";
check("пустые руки: свободные серии и просрочка",
  /3 серий без исполнителя/.test(idleText) && /1 просрочено/.test(idleText), idleText);
check("пустые руки: есть кнопка перехода", !!(idle && idle.querySelector(".idle-go")), "");

const pace = profile.querySelector("#goal-pace");
check("цель не задана: подсказан темп студии",
  pace && !pace.hidden && /4 серий на человека/.test(pace.textContent),
  pace ? `hidden=${pace.hidden} · ${pace.textContent}` : "нет блока");

const onTime = Array.from(profile.querySelectorAll(".bcell")).find(c => /Вовремя/.test(c.textContent));
check("прочерк «вовремя» объяснён", onTime && /со сроком/.test(onTime.textContent), onTime ? onTime.textContent.replace(/\s+/g, " ").trim() : "нет карточки");

if (idle && idle.querySelector(".idle-go")) {
  click(idle.querySelector(".idle-go"));
  await new Promise(r => setTimeout(r, 120));
  const chip = document.querySelector('.qf-chip[data-qf="unassigned"]');
  const listOpen = document.querySelector('.tab-panel[data-panel="list"]').classList.contains("active");
  check("кнопка ведёт в «Список» с фильтром «без исполнителя»",
    listOpen && chip && chip.classList.contains("active"),
    `вкладка=${listOpen}, чип=${chip && chip.classList.contains("active")}`);
}

click(document.querySelector("#open-qc"));
await new Promise(r => setTimeout(r, 400));

const rows = Array.from(document.querySelectorAll(".qc-row"));
check("два файла — одна таблица, а не две модалки",
  rows.length === 2 && document.querySelectorAll(".overlay").length === 1,
  `строк=${rows.length}, модалок=${document.querySelectorAll(".overlay").length}`);
check("обе дорожки посчитаны", qcCalls === 2, `вызовов qc_analyze: ${qcCalls}`);
check("не прошедшая стандарт помечена как error", rows[0] && rows[0].classList.contains("error"), rows[0] ? rows[0].className : "");
check("принятая помечена как ok", rows[1] && rows[1].classList.contains("ok"), rows[1] ? rows[1].className : "");
const verdicts = rows.map(r => r.querySelector(".st").textContent.replace(/\s+/g, " ").trim());
check("в колонке вердикт, а не счётчик находок",
  /^на доработку/.test(verdicts[0]) && /пиковый уровень/.test(verdicts[0]) && verdicts[1] === "принято",
  JSON.stringify(verdicts));
check("пик и RMS в строке", rows[0] && rows[0].querySelector(".pk").textContent === "-0.1", rows[0] ? rows[0].querySelector(".pk").textContent : "");
const progress = document.querySelector("#qc-progress");
check("итог по всем файлам", progress && /1 на доработку/.test(progress.textContent), progress ? progress.textContent : "");
check("сортировка «сначала проблемные» доступна", !!document.querySelector("#qc-sort:not([hidden])"), "");

let bad = 0;
for (const [name, ok, info] of results) { if (!ok) bad++; console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : "  — " + info}`); }
console.log(bad ? `\nПРОВАЛЕНО: ${bad} из ${results.length}` : `\nВсе ${results.length} проверок прошли`);
process.exit(bad ? 1 : 0);
