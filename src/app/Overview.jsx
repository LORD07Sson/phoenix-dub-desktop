// Вкладка «Обзор» — первый компонент на SolidJS в проекте (остальные
// вкладки остаются на vanilla JS, см. tabs.js — осознанно частичная
// миграция, не переписывание всего сразу). Данные приходят уже
// готовыми пропом: fetch и жизненный цикл монтирования — в loadOverview()
// в конце файла, та же схема, что была раньше (сходить на сервер, потом
// отрисовать), только рисует теперь Solid, а не шаблонные строки.
//
// donutHtml/donutLegendHtml (charts.js) — общие для Обзора, профиля и
// карточки коллеги, которые остаются на vanilla JS — переиспользуем как
// есть через innerHTML, а не переписываем в JSX-компонент: два разных
// рантайма на один и тот же SVG иначе неизбежно разойдутся.

import { render } from "solid-js/web";
import { For, Show, onMount } from "solid-js";
import { apiGet, openSheet, dialogSkeletonHtml } from "./api.js";
import { $, esc, initials, relTime, STATUS_COLOR_VAR } from "./utils.js";
// esc() нужен только в строковых шаблонах (openMonthlyTopSheet ниже,
// donutHtml в charts.js). В JSX его быть не должно: Solid экранирует
// текстовые узлы сам, и esc() поверх этого даёт двойное экранирование —
// имя «Иванов & Co» рендерилось как «Иванов &amp; Co».
import { donutHtml, donutLegendHtml, playDonutIntro } from "./charts.js";

// Сравнивает вторую половину 14-дневного окна с первой — тот же смысл,
// что "From Last Month" у референса, но на доступных нам данных
// (помесячного среза бэкенд не считает, а придумывать число нельзя).
function periodDeltaPct(days) {
  if (!days || days.length < 4) return null;
  const mid = Math.floor(days.length / 2);
  const firstHalf = days.slice(0, mid).reduce((s, x) => s + x.created, 0);
  const secondHalf = days.slice(mid).reduce((s, x) => s + x.created, 0);
  if (firstHalf === 0) return secondHalf === 0 ? 0 : null;
  return Math.round(((secondHalf - firstHalf) / firstHalf) * 100);
}
import { avatarHtml, loadAvatars } from "./profile.js";
import { openReportDetail } from "./report-detail.js";
import { boardCardHtml } from "./board.js";
import { timelineHtml, playTimelineIntro } from "./charts.js";
import { switchTab } from "./tabs.js";

// Русские подписи колонок для превью-канбана — у /api/dashboard/phoenix
// они приходят по-английски (Pending/In Progress/...), тем же смыслом,
// что и у референса, но остальной интерфейс студии целиком на русском
// (см. PRIORITY_LABELS/STATUS_DOT_CLASS в utils.js) — переопределяем
// только подпись, сама группировка (draft/working/review+revision/
// completed) остаётся серверной.
const PREVIEW_COLUMN_LABELS = { draft: "Черновики", working: "В работе", review: "На проверке", completed: "Завершено" };
const PREVIEW_CARDS_PER_COLUMN = 2;
const PREVIEW_TIMELINE_MAX_ROWS = 6;

function todayStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Превращает отчёт из /api/dashboard/phoenix в форму, которую ждёт
// boardCardHtml (та же карточка, что рисует настоящая «Доска» —
// board.js). daysLeft/overdue считаем тут же, как их считал бы
// board_layout на стороне Rust: без выдуманных полей, только
// deadline/status, которые и так пришли с сервера.
function toBoardCardShape(r) {
  const today = todayStr();
  const hasDeadline = !!r.deadline;
  const daysLeft = hasDeadline
    ? Math.round((Date.parse(r.deadline) - Date.parse(today)) / 86400000)
    : null;
  const overdue = hasDeadline && r.deadline < today && r.status !== "completed" && r.status !== "cancelled";
  return {
    publicId: r.public_id,
    deadline: r.deadline,
    daysLeft,
    overdue,
    priority: r.priority,
    title: r.title,
    assignees: r.assignees || [],
    filesCount: r.files_count || 0,
    notesCount: r.notes_count || 0,
    stale: false,
    unassigned: !(r.assignees && r.assignees.length),
    heat: 0,
  };
}

function KanbanPreview(props) {
  const columns = props.dash?.board?.columns || [];
  let root;
  onMount(() => { playTimelineIntro(root); });

  const ganttRows = columns
    .filter(col => col.key !== "completed")
    .flatMap(col => col.reports || [])
    .filter(r => r.created_at && r.deadline && Date.parse(r.deadline) > Date.parse(r.created_at))
    .map(r => ({
      title: r.title,
      colorVar: STATUS_COLOR_VAR[r.status] || "--s-draft",
      startMs: Date.parse(r.created_at),
      endMs: Date.parse(r.deadline),
    }))
    .sort((a, b) => a.endMs - b.endMs)
    .slice(0, PREVIEW_TIMELINE_MAX_ROWS);

  const now = Date.now();
  const rangeStart = ganttRows.length ? Math.min(...ganttRows.map(r => r.startMs)) : now;
  const rangeEnd = ganttRows.length ? Math.max(now, ...ganttRows.map(r => r.endMs)) : now;

  return (
    <div class="bcell full" style={{ "animation-delay": "380ms" }} ref={root}>
      <h3>Доска</h3>
      <Show when={ganttRows.length}>
        <div style={{ "margin-bottom": "14px" }} innerHTML={timelineHtml(ganttRows, rangeStart, rangeEnd, now)} />
      </Show>
      <div class="preview-kanban-grid">
        <For each={columns}>
          {col => (
            <div class="preview-kanban-col">
              <div class="preview-kanban-col-head">
                <span class="dot" style={{ background: `var(${STATUS_COLOR_VAR[col.key] || "--s-draft"})` }} />
                <b>{col.total}</b><span>{PREVIEW_COLUMN_LABELS[col.key] || col.label}</span>
              </div>
              <div
                class="preview-kanban-cards"
                onClick={e => {
                  const cardEl = e.target.closest("[data-open]");
                  if (cardEl) openReportDetail(cardEl.dataset.open);
                }}
                innerHTML={(col.reports || []).slice(0, PREVIEW_CARDS_PER_COLUMN)
                  .map(r => boardCardHtml(toBoardCardShape(r), r.status)).join("")
                  || `<div class="board-col-empty">пусто</div>`}
              />
            </div>
          )}
        </For>
      </div>
      <button
        class="btn"
        style={{ "margin-top": "8px", width: "100%", "justify-content": "center" }}
        onClick={() => switchTab("board")}
      >
        Открыть доску
      </button>
    </div>
  );
}

function TrendChart(props) {
  const days = props.trend?.days || [];
  const peak = Math.max(1, ...days.map(x => Math.max(x.created, x.completed)));
  const noMovement = days.every(x => x.created === 0 && x.completed === 0);
  return (
    <div class="bcell dash-trend-cell" style={{ "animation-delay": "160ms" }}>
      <div class="dash-cell-head">
        <span class="dash-cell-title">Создано и завершено</span>
        <span class="dash-cell-hint">последние 14 дней</span>
      </div>
      <div class="dash-legend">
        <span><i style={{ background: "var(--surface-4)" }} />создано</span>
        <span><i style={{ background: "var(--s-done)" }} />завершено</span>
      </div>
      <Show when={days.length && !noMovement} fallback={<div class="no-assignee">Пока без движения</div>}>
        <div class="dash-trend">
          <For each={days}>
            {x => (
              <div class="dash-trend-col" title={`${x.date}: ${x.created} создано, ${x.completed} завершено`}>
                <div class="dash-trend-bars">
                  <div class="dash-trend-bar created" style={{ height: `${Math.round((x.created / peak) * 100)}%` }} />
                  <div class="dash-trend-bar completed" style={{ height: `${Math.round((x.completed / peak) * 100)}%` }} />
                </div>
                <div class="dash-trend-label">{Number(x.date.slice(8, 10))}</div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function StatCard(props) {
  return (
    <div class="bcell kpi-cell" style={{ "animation-delay": `${props.delay}ms` }}>
      <h3>{props.label}</h3>
      <div class="dash-stat">
        <span class={`big-num ${props.tone || ""}`}>{props.value}</span>
        <Show when={props.pill}>
          <span class="dash-pill" style={{ color: `var(${props.pillVar})`, background: `color-mix(in srgb, var(${props.pillVar}) 16%, transparent)` }}>{props.pill}</span>
        </Show>
      </div>
      <div class="sub">{props.sub}</div>
    </div>
  );
}

function Overview(props) {
  const d = props.data;
  const count = st => d.reports.statuses.find(s => s.status === st)?.count || 0;
  const segments = d.reports.statuses.map(s => ({
    label: s.label, count: s.count, colorVar: STATUS_COLOR_VAR[s.status] || "--s-draft",
  }));
  const activeTotal = d.reports.total - count("completed") - count("cancelled");
  const activeDelta = periodDeltaPct(props.trend?.days);
  const maxAssigned = Math.max(1, ...d.performers.map(x => x.assigned));

  // «Требует внимания» — отчёты со статусом stuck (3+ дня без смены
  // статуса, см. _attach_stuck на сервере) из /api/dashboard/phoenix.
  const stuckReports = (props.dash?.board?.columns || [])
    .flatMap(c => c.reports || [])
    .filter(r => r.stuck)
    .slice(0, 5);
  const activity = (props.feed?.events || []).slice(0, 4);

  let root;
  onMount(() => { playDonutIntro(root); });

  return (
    <>
    <div class="page-header">
      <div>
        <h1>Обзор студии</h1>
        <div class="sub">Где сейчас находится конвейер дубляжа.</div>
      </div>
    </div>
    <div ref={root}>
      <div class="an-metrics">
        <StatCard delay={0} label="Активные серии" value={activeTotal} sub={`из ${d.reports.total} всего`}
          pill={activeDelta !== null ? `${activeDelta >= 0 ? "+" : ""}${activeDelta}%` : null}
          pillVar={activeDelta !== null && activeDelta < 0 ? "--s-stop" : "--s-done"} />
        <StatCard delay={40} label="В работе" value={count("working")} sub={`${count("review") + count("revision")} на проверке и правках`} />
        <StatCard delay={80} label="Завершено" value={count("completed")} sub="за всё время" />
        <StatCard delay={120} label="Просрочено" value={d.reports.overdue} tone={d.reports.overdue > 0 ? "danger" : ""}
          sub={`${d.reports.important} важных (высокий/срочный)`} />
      </div>

      <div class="dash-main-row">
        <TrendChart trend={props.trend} />
        <div class="dash-side">
          <div class="bcell dash-side-cell" style={{ "animation-delay": "200ms" }}>
            <div class="dash-cell-head">
              <span class="dash-cell-title">Требует внимания</span>
              <Show when={stuckReports.length}>
                <span class="dash-pill" style={{ color: "var(--s-stop)", background: "color-mix(in srgb, var(--s-stop) 16%, transparent)" }}>{stuckReports.length} без движения</span>
              </Show>
            </div>
            <div class="dash-list">
              <Show when={stuckReports.length} fallback={<div class="no-assignee">Всё движется</div>}>
                <For each={stuckReports}>
                  {r => (
                    <button type="button" class="dash-stuck-row" onClick={() => openReportDetail(r.public_id)}>
                      <span class="dash-stuck-dot" />
                      <span class="dash-stuck-text">
                        <span class="dash-stuck-title">{r.title}</span>
                        <span class="dash-stuck-sub">{r.status_label} · без движения</span>
                      </span>
                    </button>
                  )}
                </For>
              </Show>
            </div>
          </div>
          <div class="bcell dash-side-cell" style={{ "animation-delay": "240ms" }}>
            <div class="dash-cell-head">
              <span class="dash-cell-title">Недавняя активность</span>
              <button type="button" class="dash-link" onClick={() => switchTab("feed")}>вся лента</button>
            </div>
            <div class="dash-list">
              <Show when={activity.length} fallback={<div class="no-assignee">Пока тихо</div>}>
                <For each={activity}>
                  {ev => (
                    <div class="dash-activity-row">
                      <span class="avatar-bubble" style={{ "margin-left": "0" }} data-avatar-for={ev.actor_telegram_id || ""}>{initials(ev.actor || "?")}</span>
                      <span class="dash-activity-text">
                        <span><b>{ev.actor}</b> {ev.action}{ev.title ? ` · ${ev.title}` : ""}</span>
                        <span class="dash-activity-time">{relTime(ev.created_at)}</span>
                      </span>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </div>
      </div>

      <div class="bento dash-secondary">
        <div class="bcell wide" style={{ "animation-delay": "280ms" }}>
          <h3>Структура загрузки</h3>
          <div class="donut-wrap">
            <div innerHTML={donutHtml(segments)} />
            <div class="donut-legend" innerHTML={donutLegendHtml(segments)} />
          </div>
        </div>
        <div class="bcell wide" style={{ "animation-delay": "300ms" }}>
          <h3>Топ исполнителей</h3>
          <div class="an-perf-list">
            <Show when={d.performers.length} fallback={<div class="no-assignee">Пока нет данных</div>}>
              <For each={d.performers}>
                {p => (
                  <div class="an-perf">
                    <div class="an-perf-head">
                      <span>{p.name}</span>
                      <span>{p.assigned} назначено{p.overdue ? ` · просрочено ${p.overdue}` : ""}</span>
                    </div>
                    <div class="an-perf-track">
                      <div class="an-perf-fill" style={{ width: `${Math.round((p.assigned / maxAssigned) * 100)}%` }} />
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </div>
          <Show when={d.performers.length}>
            <button class="btn" style={{ "margin-top": "14px", width: "100%", "justify-content": "center" }} onClick={openMonthlyTopSheet}>
              Рейтинг месяца
            </button>
          </Show>
        </div>
        <div class="bcell kpi-cell" style={{ "animation-delay": "320ms" }}>
          <h3>Доступ</h3>
          <div class="big-num">{d.access.allowed}</div>
          <div class="sub">{d.access.pending_requests ? `${d.access.pending_requests} заявок ждут решения` : "заявок нет"}</div>
        </div>
        <div class="bcell kpi-cell" style={{ "animation-delay": "340ms" }}>
          <h3>Тикеты в поддержку</h3>
          <div class={`big-num ${d.open_tickets > 0 ? "warn" : ""}`}>{d.open_tickets}</div>
          <div class="sub">открыто сейчас</div>
        </div>
        <Show when={d.birthdays.length}>
          <div class="bcell kpi-cell" style={{ "animation-delay": "360ms" }}>
            <h3>Дни рождения</h3>
            <div class="mini-list">
              <For each={d.birthdays}>
                {b => (
                  <div class="mini-row">
                    <span class="name">{b.name}</span>
                    <span class="val">{b.day}.{String(b.month).padStart(2, "0")}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
        <Show when={props.dash?.board?.columns?.length}>
          <KanbanPreview dash={props.dash} />
        </Show>
      </div>
    </div>
    </>
  );
}

// Диалог «Рейтинг месяца» — остался на imperative openSheet (та же
// функция, что и в остальном приложении), не переписан на Solid: это
// одноразовый sheet поверх всего окна, а не часть дерева Обзора — Solid
// тут не даёт ничего сверх того, что уже даёт openSheet.
async function openMonthlyTopSheet() {
  const overlay = openSheet(`<h2>Рейтинг месяца</h2>${dialogSkeletonHtml(5)}`);
  const sheet = overlay.querySelector(".sheet");
  let d;
  try {
    d = await apiGet("/overview/monthly-top");
  } catch (e) {
    sheet.innerHTML = `<h2>Рейтинг месяца</h2><div class="bento-empty">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    return;
  }
  const medals = ["🥇", "🥈", "🥉"];
  const rows = (d.top || []).map((p, i) => `
    <div class="mini-row">
      <span class="rank">${medals[i] || i + 1}</span>
      ${avatarHtml(p.telegram_id, p.name, "sm")}
      <span class="name">${esc(p.name)}</span>
      <span class="val">${p.completed} ✓</span>
    </div>
  `).join("");
  sheet.innerHTML = `
    <h2>Рейтинг месяца</h2>
    <div style="color:var(--ink-dim); font-size:12px; margin:-8px 0 12px;">по закрытым отчётам за последние 30 дней</div>
    <div class="mini-list">${rows || `<div class="no-assignee">Пока никто не закрыл ни одной серии за последние 30 дней</div>`}</div>
    <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
  `;
  loadAvatars(sheet);
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
}

// Монтирование/размонтирование — та же схема, что была у старого
// loadOverview(): сходить на сервер, затем отрисовать заново с нуля
// (полный remount дерева на каждый вызов, не тонкое обновление сигналов
// — ровно то же поведение, что раньше давал root.innerHTML = ...).
// loadActiveTab()/refreshAll() в tabs.js продолжают звать loadOverview()
// как раньше — сигнатура (async функция без аргументов, возвращающая
// промис) не изменилась, имя файла — единственное отличие импорта.
let disposePrev = null;

export async function loadOverview() {
  const root = $("#overview-body");
  if (disposePrev) { disposePrev(); disposePrev = null; }
  root.innerHTML = `<div class="skeleton-wrap"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`;
  let d, trend, dash, feed;
  try {
    [d, trend, dash, feed] = await Promise.all([
      apiGet("/overview"),
      apiGet("/trend").catch(() => null),
      // Не критично для остального Обзора — если недоступно, просто не
      // покажем «Требует внимания», а не завалим всю вкладку.
      apiGet("/dashboard/phoenix").catch(() => null),
      apiGet("/feed", { offset: 0, page_size: 4 }).catch(() => null),
    ]);
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить обзор: ${esc(e.message)}</div>`;
    return false;
  }
  root.innerHTML = "";
  disposePrev = render(() => <Overview data={d} trend={trend} dash={dash} feed={feed} />, root);
  loadAvatars(root);
}
