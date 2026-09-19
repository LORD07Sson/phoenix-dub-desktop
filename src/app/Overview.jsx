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
import { $, esc, initials, STATUS_COLOR_VAR } from "./utils.js";
// esc() нужен только в строковых шаблонах (openMonthlyTopSheet ниже,
// donutHtml в charts.js). В JSX его быть не должно: Solid экранирует
// текстовые узлы сам, и esc() поверх этого даёт двойное экранирование —
// имя «Иванов & Co» рендерилось как «Иванов &amp; Co».
import { donutHtml, donutLegendHtml, playDonutIntro, sparklineHtml, kpiRingHtml, playRingIntro, segmentedBarHtml, segBadgesHtml, segLegendHtml, playSegBarIntro, deltaPillHtml } from "./charts.js";

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

function TrendChart(props) {
  return (
    <Show when={props.trend && props.trend.days && props.trend.days.length}>
      {() => {
        const days = props.trend.days;
        const peak = Math.max(1, ...days.map(x => Math.max(x.created, x.completed)));
        const noMovement = peak <= 1 && days.every(x => x.created === 0 && x.completed === 0);
        return (
          <div class="bcell wide" style={{ "animation-delay": "200ms" }}>
            <h3>Динамика за 14 дней</h3>
            <Show
              when={!noMovement}
              fallback={<div class="no-assignee">🌱 Пока без движения</div>}
            >
              <div class="trend-chart">
                <For each={days}>
                  {x => (
                    <div class="trend-col" title={`${x.date}: ${x.created} создано, ${x.completed} завершено`}>
                      <div class="trend-bar-fill created" style={{ height: `${Math.round((x.created / peak) * 100)}%` }} />
                      <div class="trend-bar-fill completed" style={{ height: `${Math.round((x.completed / peak) * 100)}%` }} />
                    </div>
                  )}
                </For>
              </div>
              <div class="trend-axis">
                <span>{days[0].date.slice(5).replace("-", ".")}</span>
                <span>{days[days.length - 1].date.slice(5).replace("-", ".")}</span>
              </div>
              <div class="trend-legend-row">
                <span><i style={{ background: "var(--ember)" }} />создано</span>
                <span><i style={{ background: "var(--s-done)" }} />завершено</span>
              </div>
            </Show>
          </div>
        );
      }}
    </Show>
  );
}

function Overview(props) {
  const d = props.data;
  const segments = d.reports.statuses.map(s => ({
    label: s.label, count: s.count, colorVar: STATUS_COLOR_VAR[s.status] || "--s-draft",
  }));
  const activeTotal = d.reports.total
    - (d.reports.statuses.find(s => s.status === "completed")?.count || 0)
    - (d.reports.statuses.find(s => s.status === "cancelled")?.count || 0);

  let donutRoot;
  onMount(() => { playDonutIntro(donutRoot); playRingIntro(donutRoot); playSegBarIntro(donutRoot); });

  // Спарклайн под «Всего активных» — тренд входящих (created) за то же
  // окно, что и большой график динамики ниже: показывает, разгоняется
  // или затихает поток новых серий, не только текущий снимок числа.
  const createdSeries = props.trend?.days?.map(x => x.created) || null;
  const overdueFrac = activeTotal ? d.reports.overdue / activeTotal : 0;
  const activeDelta = periodDeltaPct(props.trend?.days);

  return (
    <>
    <div class="page-header">
      <h1>Обзор</h1>
      <div class="sub">Нагрузка студии одним взглядом: что в работе, что горит, кто ведёт.</div>
    </div>
    <div class="bento" ref={donutRoot}>
      <div class="bcell wide bcell-hero" style={{ "animation-delay": "0ms" }}>
        <h3>Структура загрузки</h3>
        <div class="donut-wrap">
          <div innerHTML={donutHtml(segments)} />
          <div class="donut-legend" innerHTML={donutLegendHtml(segments)} />
        </div>
      </div>
      <div class="bcell kpi-cell" style={{ "animation-delay": "60ms" }}>
        <h3>Всего активных</h3>
        <div class="kpi-row">
          <span class="kpi-icon" style={{ background: "color-mix(in srgb, var(--fire) 20%, var(--surface-2))", color: "var(--fire)" }}>📁</span>
          <div class="big-num">{activeTotal}</div>
          <Show when={activeDelta !== null}><span innerHTML={deltaPillHtml(activeDelta)} /></Show>
          <Show when={createdSeries}>
            <div class="kpi-spark" innerHTML={sparklineHtml(createdSeries, { colorVar: "--ember" })} />
          </Show>
        </div>
        <div class="sub">из {d.reports.total} всего</div>
        <div class="seg-badges" innerHTML={segBadgesHtml(segments)} />
        <div innerHTML={segmentedBarHtml(segments)} />
        <div class="seg-legend" innerHTML={segLegendHtml(segments)} />
      </div>
      <div class="bcell kpi-cell" style={{ "animation-delay": "100ms" }}>
        <h3>Просрочено</h3>
        <div class="kpi-row">
          <span class="kpi-icon" style={{ background: `color-mix(in srgb, var(${d.reports.overdue > 0 ? "--s-stop" : "--s-done"}) 20%, var(--surface-2))`, color: `var(${d.reports.overdue > 0 ? "--s-stop" : "--s-done"})` }}>⏰</span>
          <div class={`big-num ${d.reports.overdue > 0 ? "danger" : ""}`}>{d.reports.overdue}</div>
          <Show when={activeTotal > 0}>
            <div class="kpi-ring-wrap" innerHTML={kpiRingHtml(overdueFrac, { colorVar: d.reports.overdue > 0 ? "--s-stop" : "--s-done" })} />
          </Show>
        </div>
        <div class="sub">{d.reports.important} важных (высокий/срочный)</div>
      </div>
      <div class="bcell" style={{ "animation-delay": "140ms" }}>
        <h3>Доступ</h3>
        <div class="kpi-row">
          <span class="kpi-icon" style={{ background: "color-mix(in srgb, var(--s-done) 20%, var(--surface-2))", color: "var(--s-done)" }}>🔓</span>
          <div class="big-num">{d.access.allowed}</div>
        </div>
        <div class="sub">{d.access.pending_requests ? `${d.access.pending_requests} заявок ждут решения` : "заявок нет"}</div>
      </div>
      <div class="bcell" style={{ "animation-delay": "180ms" }}>
        <h3>Тикеты в поддержку</h3>
        <div class="kpi-row">
          <span class="kpi-icon" style={{ background: `color-mix(in srgb, var(${d.open_tickets > 0 ? "--s-work" : "--ink-dim"}) 20%, var(--surface-2))`, color: `var(${d.open_tickets > 0 ? "--s-work" : "--ink-dim"})` }}>🎫</span>
          <div class={`big-num ${d.open_tickets > 0 ? "warn" : ""}`}>{d.open_tickets}</div>
        </div>
        <div class="sub">открыто сейчас</div>
      </div>
      <TrendChart trend={props.trend} />
      <div class="bcell wide" style={{ "animation-delay": "220ms" }}>
        <h3>Топ исполнителей</h3>
        <div class="mini-list">
          <Show when={d.performers.length} fallback={<div class="no-assignee">Пока нет данных</div>}>
            <For each={d.performers}>
              {(p, i) => (
                <div class="mini-row">
                  <span class="rank">{i() + 1}</span>
                  <span class="avatar-bubble" style={{ "margin-left": "0" }}>{initials(p.name)}</span>
                  <span class="name">{p.name}</span>
                  <span class="val">{p.assigned} назначено{p.overdue ? ` · ⏰${p.overdue}` : ""}</span>
                </div>
              )}
            </For>
          </Show>
        </div>
        <Show when={d.performers.length}>
          <button
            class="btn"
            style={{ "margin-top": "8px", width: "100%", "justify-content": "center" }}
            onClick={openMonthlyTopSheet}
          >
            📆 Рейтинг месяца →
          </button>
        </Show>
      </div>
      <Show when={d.birthdays.length}>
        <div class="bcell" style={{ "animation-delay": "260ms" }}>
          <h3>Дни рождения</h3>
          <div class="mini-list">
            <For each={d.birthdays}>
              {b => (
                <div class="mini-row">
                  <span class="name">🎂 {b.name}</span>
                  <span class="val">{b.day}.{String(b.month).padStart(2, "0")}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
    </>
  );
}

// Диалог «Рейтинг месяца» — остался на imperative openSheet (та же
// функция, что и в остальном приложении), не переписан на Solid: это
// одноразовый sheet поверх всего окна, а не часть дерева Обзора — Solid
// тут не даёт ничего сверх того, что уже даёт openSheet.
async function openMonthlyTopSheet() {
  const overlay = openSheet(`<h2>📆 Рейтинг месяца</h2>${dialogSkeletonHtml(5)}`);
  const sheet = overlay.querySelector(".sheet");
  let d;
  try {
    d = await apiGet("/overview/monthly-top");
  } catch (e) {
    sheet.innerHTML = `<h2>📆 Рейтинг месяца</h2><div class="bento-empty">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
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
    <h2>📆 Рейтинг месяца</h2>
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
  let d, trend;
  try {
    [d, trend] = await Promise.all([apiGet("/overview"), apiGet("/trend").catch(() => null)]);
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить обзор: ${esc(e.message)}</div>`;
    return false;
  }
  root.innerHTML = "";
  disposePrev = render(() => <Overview data={d} trend={trend} />, root);
}
