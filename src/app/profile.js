// Вкладка «Я» + карточка коллеги + список команды.
// Разметка и логика ниже — портированы «в точь-точь» из мини-аппа
// (miniapp/static/index.html: profileHtml/teamTeaserHtml/statDonutHtml/
// goalRingHtml/rankTagHtml/tenureTier/avatarHtml), под тот же /api/me
// и /api/user/{id} (совместимая форма ответа — общая разметка на двоих).

import { state } from "./state.js";
import { fillRemindersCard } from "./reminders.js";
import { fetchPerson, workSectionHtml, wireWorkSection, fillPauseCard } from "./people.js";
import { apiGet, apiPost, apiDelete, openSheet, toast, dialogSkeletonHtml, mediaUrl } from "./api.js";
import { $, esc, isOverdue, relTime, MONTHS_RU, STATUS_COLOR_VAR, BADGE_RARITY_ORDER, pluralColleagues, showContextMenu } from "./utils.js";
import { setQuickFilter, loadReports } from "./reports.js";
import { switchTab } from "./tabs.js";
import { donutHtml, donutLegendHtml, playDonutIntro } from "./charts.js";
import { devModeActive, devPanelHtml, wireDevPanel } from "./devmode.js";
import { openReportDetail } from "./report-detail.js";
import { openExternal, sendNotification } from "./tauri.js";
import { markMyReportsSeen } from "./notifications.js";
// Тот же маскот, что на экране загрузки (index.html) — Vite отдаёт
// готовый URL собранного ассета. Больше ему показаться негде, хотя он
// уже лежит в каждой сборке.
import mascotUrl from "../assets/ayaya-club-ayaya.gif";

export function avatarHtml(telegramId, name, size) {
  const initial = esc((name || "?").trim().charAt(0).toUpperCase() || "?");
  const cls = size === "xl" ? " xl" : (size === "sm" ? " sm" : "");
  return `<span class="avatar${cls}" data-avatar-for="${telegramId || ""}">${initial}</span>`;
}

// Реальные фото участников подгружаются лениво поверх инициалов —
// тот же приём, что в мини-аппе: отдельный <img>, а не background,
// чтобы молча остаться на инициалах при 204/ошибке сети (см. /api/avatar).
export function loadAvatars(root) {
  (root || document).querySelectorAll("[data-avatar-for]").forEach(el => {
    const tid = el.getAttribute("data-avatar-for");
    if (!tid || el.getAttribute("data-avatar-loaded")) return;
    el.setAttribute("data-avatar-loaded", "1");
    const img = new Image();
    img.onload = () => { el.innerHTML = ""; el.appendChild(img); };
    img.onerror = () => {};
    const src = mediaUrl(`/avatar/${encodeURIComponent(tid)}`);
    if (!src) return; // без токена запрашивать нечего
    img.src = src;
  });
}

// Своя картинка баннера профиля (/api/banner/{id}) — 204, если её нет
// (пресет/пусто), тогда молча остаёмся на градиенте из CSS.
function loadProfileBanner(el, telegramId) {
  if (!el || !telegramId) return;
  const img = new Image();
  img.onload = () => {
    el.style.backgroundImage = `url(${img.src})`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
  };
  img.onerror = () => {};
  const src = mediaUrl(`/banner/${encodeURIComponent(telegramId)}`);
  if (!src) return;
  img.src = src;
}

// Кольцо аватара по стажу в команде — те же пороги, что в мини-аппе.
// Раньше кольцо просто меняло цвет на 30/180/365 днях и молчало: человек
// не знал ни что оно означает, ни сколько осталось до следующего. Теперь
// пороги живут одним списком — из него и цвет кольца, и полоска прогресса.
const TENURE_STEPS = [
  { at: 30, tier: "bronze", label: "Бронза", color: "#b0774a" },
  { at: 180, tier: "silver", label: "Серебро", color: "#b9c2cc" },
  { at: 365, tier: "gold", label: "Золото", color: "var(--gold)" },
];

function tenureTier(days) {
  if (days == null) return null;
  for (let i = TENURE_STEPS.length - 1; i >= 0; i--) {
    if (days >= TENURE_STEPS[i].at) return TENURE_STEPS[i].tier;
  }
  return null;
}

function pluralDays(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "дня";
  return "дней";
}

// Полоска «где я между порогами» + сколько до следующего кольца.
function tenureProgressHtml(days) {
  if (days == null) return "";
  const nextIdx = TENURE_STEPS.findIndex(st => days < st.at);
  const current = nextIdx === -1 ? TENURE_STEPS[TENURE_STEPS.length - 1] : TENURE_STEPS[nextIdx - 1];
  const next = nextIdx === -1 ? null : TENURE_STEPS[nextIdx];
  const from = current ? current.at : 0;
  const pct = next ? Math.max(0, Math.min(100, Math.round(((days - from) / (next.at - from)) * 100))) : 100;
  const color = current ? current.color : "var(--ink-dim)";
  const title = current ? current.label : "Новичок";
  const left = next ? next.at - days : 0;

  return `
    <div class="tenure">
      <div class="tenure-lbl">
        <b style="color:${color};">${esc(title)}</b> · ${days} ${pluralDays(days)} в команде
        ${next ? `<span>${left} ${pluralDays(left)} до «${esc(next.label)}»</span>` : `<span>высший ранг</span>`}
      </div>
      <div class="tenure-track"><i style="width:${pct}%; background:${color};"></i></div>
      <div class="tenure-ticks">
        ${TENURE_STEPS.map(st => `<span class="${days >= st.at ? "on" : ""}" style="${days >= st.at ? `color:${st.color};` : ""}">${st.at}</span>`).join("")}
      </div>
    </div>`;
}

function roleMeta(role) {
  const r = (role || "").toLowerCase();
  if (r.includes("актр") || r.includes("актё") || r.includes("дублир")) return { ic: "🎙", c: "var(--sakura)" };
  if (r.includes("режисс")) return { ic: "🎬", c: "var(--fire)" };
  if (r.includes("звукореж")) return { ic: "🔊", c: "var(--s-review)" };
  if (r.includes("перевод")) return { ic: "📝", c: "var(--gold)" };
  if (r.includes("тайпсет") || r.includes("тайминг")) return { ic: "⏱", c: "var(--ember)" };
  if (r.includes("монтаж")) return { ic: "🎞", c: "var(--sakura)" };
  if (r.includes("дизайн")) return { ic: "✏️", c: "var(--gold)" };
  return { ic: "🎭", c: "var(--fire)" };
}

function rankTagHtml(rank) {
  // «#1 из 1» — не достижение, а следствие того, что серии закрывал
  // только один человек. Пока в таблице меньше двоих, места нет.
  if (!rank || !rank.total || rank.total < 2) return "";
  const medals = { 1: "🥇", 2: "🥈", 3: "🥉" };
  const medal = medals[rank.place] || "🏅";
  return `<span class="rank-tag rank-${rank.place <= 3 ? rank.place : "other"}">${medal} #${rank.place} из ${rank.total}</span>`;
}

function goalRingHtml(pct, over) {
  const r = 30, c = 2 * Math.PI * r;
  return `<svg class="goal-ring" viewBox="0 0 70 70" width="70" height="70">
    <circle class="goal-ring-track" cx="35" cy="35" r="${r}"></circle>
    <circle class="goal-ring-fill${over ? " over" : ""}" cx="35" cy="35" r="${r}"
      stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${c.toFixed(2)}"
      data-target-offset="${(c - (pct / 100) * c).toFixed(2)}"></circle>
  </svg>`;
}

// Аватар-стек команды в общей шапке (titlebar) — виден на любой
// вкладке, не только на «Я». Перенесено вживую с референса пользователя
// (Dribbble: Xentra Digital Marketing Dashboard, dribbble.com/shots/27265906)
// — там кластер "N People / Team Members" с перекрывающимися аватарами
// висит в шапке постоянно. Данные и разметка — те же /team + avatarHtml,
// что уже питают тизер на вкладке «Я» и полный список (openTeamSheet)
// ниже, просто с другим местом вывода и лимитом превью.
export async function loadTitlebarTeam() {
  const el = $("#titlebar-team");
  if (!el) return;
  try {
    const d = await apiGet("/team");
    const users = d.users || [];
    if (!users.length) { el.hidden = true; return; }
    const preview = users.slice(0, 4);
    const overflow = users.length - preview.length;
    // Стек аватаров заканчивается кружком "+N" на месте непоказанных
    // участников — та же деталь, что у референса ("21+" в шапке), не
    // просто текстовая подпись сбоку.
    const stack = preview.map(u => avatarHtml(u.telegram_id, u.name, "sm")).join("")
      + (overflow > 0 ? `<span class="avatar sm avatar-overflow">+${overflow}</span>` : "");
    el.innerHTML = `<span class="stack">${stack}</span><span class="tt">${users.length} ${pluralColleagues(users.length)}</span>`;
    el.hidden = false;
    loadAvatars(el);
  } catch (_) { /* не критично — шапка просто останется без кластера */ }
}
$("#titlebar-team")?.addEventListener("click", openTeamSheet);

function teamTeaserHtml(me) {
  if (!me.team || !me.team.count) return "";
  const stack = me.team.preview.map(u => avatarHtml(u.telegram_id, u.name, "sm")).join("");
  const names = me.team.preview.map(u => u.name).join(", ");
  return `
    <div class="team-teaser" id="team-teaser">
      <span class="stack">${stack}</span>
      <div><div class="tt">${me.team.count} ${pluralColleagues(me.team.count)} по студии</div>
      ${names ? `<div class="tsub">${esc(names)}${me.team.count > me.team.preview.length ? " и др." : ""}</div>` : ""}</div>
      <span class="go">→</span>
    </div>`;
}

// «Структура загрузки» — донат по статусам активных отчётов + разбивка
// по ролям пайплайна, одной озаглавленной карточкой (как в мини-аппе),
// с явным пустым состоянием вместо того, чтобы просто не показывать
// раздел при отсутствии данных.
function loadStructureHtml(me) {
  const hasReports = me.reports && me.reports.length;
  const hasRoles = me.role_breakdown && me.role_breakdown.length;
  if (!hasReports && !hasRoles) {
    // Раньше тут был статичный текст «пока нечего показать» во всю
    // ширину экрана. Пустые руки — это повод предложить работу, а не
    // сообщить о пустоте: свободные серии дозагружаются в fillIdleSlot().
    return `
      <div class="bcell profile-section">
      <h3>Структура загрузки</h3>
      <div class="idle-card" id="idle-slot">
        <img class="idle-mascot" src="${mascotUrl}" alt="">
        <div class="idle-text">
          <div class="t">На руках пусто</div>
          <div class="d">смотрю, есть ли свободные серии…</div>
        </div>
      </div>
      </div>
    `;
  }
  const statusCounts = {};
  for (const r of me.reports || []) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  const segments = Object.entries(STATUS_COLOR_VAR)
    .filter(([status]) => statusCounts[status])
    .map(([status, colorVar]) => ({
      label: state.statusOptions.find(([v]) => v === status)?.[1] || status,
      count: statusCounts[status],
      colorVar,
    }));
  const donutBlock = hasReports ? `
    <div class="donut-wrap">
      ${donutHtml(segments)}
      <div class="donut-legend">${donutLegendHtml(segments)}</div>
    </div>` : "";
  const roleBlock = hasRoles ? `
    <div class="profile-subtitle" style="margin-top:${hasReports ? "16px" : "0"};">Роли в пайплайне</div>
    ${me.role_breakdown.map(rb => `
      <div class="role-bar-row">
        <div class="label"><span>${esc(rb.role)}</span><span>${rb.count} · ${rb.pct}%</span></div>
        <div class="role-bar-track"><div class="role-bar-fill" data-pct="${rb.pct}"></div></div>
      </div>
    `).join("")}` : "";
  return `
    <div class="bcell profile-section">
      <h3>Структура загрузки</h3>
      ${donutBlock}${roleBlock}
    </div>
  `;
}

// Шапка + тизер команды + цитата статуса + био + метастрока + «Структура
// загрузки» — общая часть между своей «Я» и карточкой коллеги.
// isSelf — показать карандаш редактирования статуса/био (только на
// собственном профиле, /api/me/profile правит только СВОЙ профиль).
//
// asParts=true — вернуть { left, right } отдельно, а не склеенной
// строкой: на широком окне ПК своя «Я» кладёт карточку человека в левую
// колонку (прилипает при скролле), а статус/био/структуру загрузки —
// в правую, пошире (см. loadProfile). Карточка коллеги (sheet, узкая)
// продолжает звать без asParts и получает прежнюю плоскую разметку.
function profileHeaderHtml(d, isSelf, asParts) {
  const tier = tenureTier(d.member_since_days);
  const rMeta = roleMeta(d.role);
  const roleLabel = d.role ? esc(d.role) : "Участник PHOENIX";

  let joinedLine = "";
  if (d.created_at) {
    const jd = new Date(d.created_at.replace(" ", "T") + "Z");
    if (!isNaN(jd.getTime())) {
      joinedLine = ` · в команде с ${jd.getUTCDate()} ${MONTHS_RU[jd.getUTCMonth() + 1]}. ${jd.getUTCFullYear()}`;
    }
  }

  const left = `
    <div class="profile-banner-wrap" data-role="profile-banner"></div>
    <div class="profile-head-card">
      <span class="avatar-ring${tier ? " tier-" + tier : ""}">${avatarHtml(d.telegram_id, d.display_name || d.name, "xl")}</span>
      <div class="nm-row">
        <span class="nm">${esc(d.display_name || d.name)}</span>
        ${d.is_developer || d.is_owner ? `<span class="dev-pill">DEV</span>` : ""}
        ${rankTagHtml(d.studio_rank)}
      </div>
      ${d.username ? `<div class="un">@${esc(d.username)}</div>` : ""}
      ${d.internal_id != null ? `<div class="id-row"><span class="id-chip">#${d.internal_id}</span>${joinedLine}${d.is_online ? ` · <span style="color:var(--s-done); font-weight:600;">в сети</span>` : ""}</div>` : ""}
      <span class="role-tag" style="--tag-c:${rMeta.c}">${rMeta.ic} ${roleLabel}</span>
    </div>

    ${tenureProgressHtml(d.member_since_days)}
    ${teamTeaserHtml(d)}
    ${isSelf ? `<button class="btn profile-edit-btn" id="btn-edit-profile" title="Изменить статус и о себе"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="M13.5 6.5l4 4"/></svg>Изменить профиль</button>` : ""}
  `;

  const right = `
    ${d.status_text ? `<div class="status-quote">${esc(d.status_text)}</div>` : ""}
    ${d.bio ? `<div class="profile-bio">${esc(d.bio)}</div>` : ""}

    ${asParts ? "" : `<div class="bc-meta-line">${d.assigned} на нём сейчас${d.overdue ? ` · <span class="warn">⏰ ${d.overdue} просрочено</span>` : ""}${d.avg_days != null ? ` · ⏱ в среднем ${d.avg_days.toFixed ? d.avg_days.toFixed(1) : d.avg_days} дн.` : ""}</div>`}

    ${loadStructureHtml(d)}
  `;

  return asParts ? { left, right } : left + right;
}

// Достижения — общий бенто-блок, тоже переиспользуется для «Я» и чужого профиля.
//
// Полученные и неполученные раньше выглядели почти одинаково, а прогресс
// (current/target сервер присылает по каждой награде) был спрятан в
// атрибуте title — то есть виден, только если задержать мышь на иконке.
// Теперь полученные идут чипами сверху, а остальные — строкой с остатком
// и полоской: «50+ закрыто — 1 / 50» честнее серой иконки без объяснений.
function badgesBentoHtml(d, delayMs) {
  const all = (d.badges || []).slice().sort((a, b) => (BADGE_RARITY_ORDER[a.rarity] ?? 9) - (BADGE_RARITY_ORDER[b.rarity] ?? 9));
  const unlocked = all.filter(b => b.unlocked);
  const locked = all.filter(b => !b.unlocked);

  const wonHtml = unlocked.map(b => `
    <span class="badge-chip" title="${esc(b.label)}">
      ${esc(b.icon)} ${esc(b.label)}
      ${b.custom && devModeActive() ? `<button class="icon-btn badge-revoke" data-revoke-badge="${b.id}" title="Отозвать награду">✕</button>` : ""}
    </span>`).join("");

  const lockedHtml = locked.map(b => {
    const has = b.target ? Math.max(0, Math.min(b.target, b.current || 0)) : null;
    const pct = b.target ? Math.round((has / b.target) * 100) : 0;
    return `
      <div class="badge-todo${b.target ? "" : " no-data"}">
        <div class="lbl">
          <span>${esc(b.icon)} ${esc(b.label)}</span>
          <span class="val">${b.target ? `${has} / ${b.target}` : "нет данных"}</span>
        </div>
        <div class="badge-track"><i style="width:${pct}%;"></i></div>
      </div>`;
  }).join("");

  return `
    <div class="bcell wide" style="animation-delay:${delayMs}ms;">
      <h3>Достижения ${all.length ? `<span style="color:var(--ink-dim); font-weight:400; font-size:12px;">${unlocked.length} из ${all.length}</span>` : ""}</h3>
      ${wonHtml ? `<div class="badge-chips">${wonHtml}</div>` : ""}
      ${lockedHtml ? `<div class="badge-todos">${lockedHtml}</div>` : ""}
      ${!all.length ? `<div class="no-assignee">Пока пусто</div>` : ""}
    </div>`;
}

function wireProfileCommon(root, telegramId, onReload) {
  loadAvatars(root);
  loadProfileBanner(root.querySelector('[data-role="profile-banner"]'), telegramId);
  playDonutIntro(root);
  root.querySelectorAll(".role-bar-fill").forEach(el => {
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.width = el.dataset.pct + "%"; }));
  });
  root.querySelectorAll(".goal-ring-fill").forEach(el => {
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.strokeDashoffset = el.dataset.targetOffset; }));
  });
  root.querySelectorAll("[data-revoke-badge]").forEach(btn => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm("Отозвать эту награду?")) return;
      btn.disabled = true;
      try {
        await apiDelete(`/dev/badge/${btn.dataset.revokeBadge}`);
        toast("Награда отозвана.");
        if (onReload) await onReload();
      } catch (e) {
        toast(`Не удалось отозвать: ${e.message}`, "error");
        btn.disabled = false;
      }
    });
  });
  const teaser = root.querySelector("#team-teaser");
  if (teaser) teaser.addEventListener("click", openTeamSheet);
}

export async function loadProfile() {
  const root = $("#profile-body");
  root.innerHTML = `<div class="skeleton-wrap"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`;
  let me;
  try {
    me = await apiGet("/me");
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить профиль: ${esc(e.message)}</div>`;
    return false;
  }
  state.isDeveloper = !!me.is_developer; // используется для показа переключателя dev-режима в Настройках
  markMyReportsSeen((me.reports || []).map(r => r.public_id));

  const goalSet = me.monthly_goal != null && me.monthly_goal > 0;
  const goalDone = me.completed_month || 0;
  const goalOver = goalSet && goalDone >= me.monthly_goal;
  const goalPct = goalSet ? Math.min(100, Math.round((goalDone / me.monthly_goal) * 100)) : 0;
  const goalCardHtml = goalSet ? `
    <div class="bcell wide goal-card with-ring" id="goal-card">
      <div class="goal-ring-wrap">${goalRingHtml(goalPct, goalOver)}
        <div class="goal-ring-label"><b>${goalDone}</b><span>из ${me.monthly_goal}</span></div>
      </div>
      <div><h3 style="margin-bottom:4px;">Цель месяца</h3><div class="cap">${goalOver ? "цель выполнена" : `выполнено <b>${goalPct}%</b>`}</div>
      <div class="edit-hint">изменить</div></div>
    </div>
  ` : `
    <div class="bcell wide goal-card" id="goal-card">
      <h3>Цель месяца</h3>
      <div class="goal-hint" style="margin-top:4px;">Цель на месяц не задана — нажмите, чтобы поставить себе план.</div>
      <div class="goal-hint" id="goal-pace" hidden></div>
    </div>
  `;

  const kpi = (label, val, sub, empty) => `
    <div class="pf-kpi${empty ? " empty" : ""}">
      <span class="l">${label}</span>
      <b>${empty ? "пока нет" : val}</b>
      <span class="s">${sub}</span>
    </div>`;

  root.innerHTML = `
    <div class="pf">
      ${myHeroHtml(me)}
      <div class="pf-kpis">
        ${kpi("Сейчас на мне", me.assigned ?? 0, me.overdue ? `<span class="warn">${me.overdue} просрочено</span>` : "всё в сроках")}
        ${kpi("Закрыто", me.completed_total ?? 0, `${me.completed_week ?? 0} за неделю · ${me.completed_month ?? 0} за месяц`)}
        ${kpi("Вовремя", `${me.on_time_pct}%`, me.on_time_pct != null ? "закрыто не позже срока" : "появится после первого отчёта со сроком", me.on_time_pct == null)}
        ${kpi("Средний срок", `${me.avg_days != null ? me.avg_days.toFixed(1) : ""} дн.`, me.avg_days != null ? "на один отчёт" : "появится после первой закрытой серии", me.avg_days == null)}
      </div>
      <div class="pf-grid">
        <div class="pf-main">
          ${myWorkHtml(me)}
          ${myBadgesHtml(me)}
          <section class="pf-card" id="activity-card">
            <div class="pf-card-head"><h3>Последние действия</h3><button class="pf-link" id="activity-all">вся активность →</button></div>
            <div class="pf-acts" id="activity-list"><div class="pf-quiet">загружаю…</div></div>
          </section>
        </div>
        <aside class="pf-side">
          ${goalCardHtml}
          <section class="pf-card pf-tenure">${tenureProgressHtml(me.member_since_days) || `<div class="pf-quiet">стаж появится позже</div>`}</section>
          <section class="pf-card pf-notif">
            <h3>Уведомления</h3>
            <div class="pf-notif-row" id="reminders-card" role="button" tabindex="0"></div>
            <div class="pf-notif-row" id="pause-card" role="button" tabindex="0"></div>
          </section>
          ${teamTeaserHtml(me)}
        </aside>
      </div>
      ${devModeActive() ? devPanelHtml(me) : ""}
    </div>
  `;
  wireProfileCommon(root, me.telegram_id, () => loadProfile());
  // Обе догрузки — без await: профиль уже отрисован, и ждать ради
  // подсказки в одном блоке незачем (иначе на них ждала бы и кнопка
  // «Обновить», которая дожидается loadProfile).
  if (state.isAdmin) fillIdleSlot(root);
  fillPauseCard(root, me.telegram_id);
  fillRemindersCard(root);
  fillRecentActivity(root);
  let suggested = null;
  if (!goalSet) suggestGoal(root).then(v => { suggested = v; });
  root.querySelector("#goal-card").addEventListener("click", () => monthlyGoalDialog(me.monthly_goal || suggested));
  root.querySelector("#btn-edit-profile").addEventListener("click", () => editProfileDialog(me));
  root.querySelector("#activity-all").addEventListener("click", () => openMyActivitySheet());
  root.querySelectorAll("[data-open-report]").forEach(row => {
    row.addEventListener("click", () => openReportDetail(row.dataset.openReport));
  });
  if (devModeActive()) wireDevPanel(root, me.telegram_id, () => loadProfile(), me.role);
  notifyGoalReachedIfNeeded(me, goalSet, goalOver, goalDone);
}

// Шапка своей «Я»: баннер во всю ширину, аватар, имя и о себе одним
// блоком — раньше статус и био жили отдельными полосами под KPI.
function myHeroHtml(d) {
  const tier = tenureTier(d.member_since_days);
  const rMeta = roleMeta(d.role);
  let joined = "";
  if (d.created_at) {
    const jd = new Date(d.created_at.replace(" ", "T") + "Z");
    if (!isNaN(jd.getTime())) joined = `в команде с ${jd.getUTCDate()} ${MONTHS_RU[jd.getUTCMonth() + 1]}. ${jd.getUTCFullYear()}`;
  }
  const meta = [
    d.username ? `@${esc(d.username)}` : "",
    d.internal_id != null ? `<span class="id-chip">#${d.internal_id}</span>` : "",
    joined,
    d.is_online ? `<span class="on">в сети</span>` : "",
  ].filter(Boolean).join(`<i class="dot"></i>`);
  const about = d.status_text || d.bio ? `
    <div class="pf-about">
      ${d.status_text ? `<div class="st">${esc(d.status_text)}</div>` : ""}
      ${d.bio ? `<div class="bio">${esc(d.bio)}</div>` : ""}
    </div>` : `<div class="pf-about empty">Статус и пара слов о себе — их видят коллеги в карточке профиля.</div>`;
  return `
    <section class="pf-hero">
      <div class="pf-banner" data-role="profile-banner"></div>
      <div class="pf-hero-body">
        <span class="avatar-ring${tier ? " tier-" + tier : ""}">${avatarHtml(d.telegram_id, d.display_name || d.name, "xl")}</span>
        <div class="pf-who">
          <div class="nm-row">
            <span class="nm">${esc(d.display_name || d.name)}</span>
            ${d.is_developer || d.is_owner ? `<span class="dev-pill">DEV</span>` : ""}
            ${rankTagHtml(d.studio_rank)}
            <span class="role-tag" style="--tag-c:${rMeta.c}">${rMeta.ic} ${d.role ? esc(d.role) : "Участник PHOENIX"}</span>
          </div>
          <div class="pf-meta">${meta}</div>
          ${about}
        </div>
        <button class="btn pf-edit" id="btn-edit-profile"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="M13.5 6.5l4 4"/></svg>Изменить</button>
      </div>
    </section>`;
}

// «Моя работа» — вместо огромного доната на одно значение: тонкая
// полоска по статусам и сам список того, что на руках.
function myWorkHtml(me) {
  const reports = me.reports || [];
  if (!reports.length) {
    return `
      <section class="pf-card">
        <div class="pf-card-head"><h3>Моя работа</h3></div>
        <div class="idle-card" id="idle-slot">
          <img class="idle-mascot" src="${mascotUrl}" alt="">
          <div class="idle-text"><div class="t">На руках пусто</div><div class="d">${state.isAdmin ? "смотрю, есть ли свободные серии…" : "когда назначат серию, она появится здесь"}</div></div>
        </div>
      </section>`;
  }
  const counts = {};
  for (const r of reports) counts[r.status] = (counts[r.status] || 0) + 1;
  const label = st => state.statusOptions.find(([v]) => v === st)?.[1] || st;
  const segs = Object.entries(STATUS_COLOR_VAR).filter(([st]) => counts[st]);
  const bar = segs.map(([st, c]) => `<i style="flex:${counts[st]}; background:var(${c});" title="${esc(label(st))}: ${counts[st]}"></i>`).join("");
  const legend = segs.map(([st, c]) => `<span><i style="background:var(${c});"></i>${esc(label(st))} <b>${counts[st]}</b></span>`).join("");
  const rows = reports.slice(0, 6).map(r => {
    const late = isOverdue(r);
    const c = STATUS_COLOR_VAR[r.status] || "--ink-dim";
    return `
      <button class="pf-rep" data-open-report="${esc(r.public_id)}">
        <i class="pf-rep-dot" style="background:var(${c});"></i>
        <span class="t">${esc(r.title || r.public_id)}</span>
        <span class="id">${esc(r.public_id)}</span>
        <span class="st" style="--c:var(${c});">${esc(r.status_label || label(r.status))}</span>
        <span class="dl${late ? " late" : ""}">${r.deadline ? `${late ? "просрочено · " : "до "}${esc(r.deadline.slice(8, 10))}.${esc(r.deadline.slice(5, 7))}` : "без срока"}</span>
      </button>`;
  }).join("");
  const roles = (me.role_breakdown || []).map(rb => `<span class="pf-role">${esc(rb.role)} <b>${rb.pct}%</b></span>`).join("");
  return `
    <section class="pf-card">
      <div class="pf-card-head"><h3>Моя работа <span class="n">${reports.length}</span></h3></div>
      <div class="pf-bar">${bar}</div>
      <div class="pf-legend">${legend}</div>
      <div class="pf-reps">${rows}</div>
      ${reports.length > 6 ? `<div class="pf-quiet">и ещё ${reports.length - 6} — во вкладке «Список»</div>` : ""}
      ${roles ? `<div class="pf-roles"><span class="l">Роли в пайплайне</span>${roles}</div>` : ""}
    </section>`;
}

// Достижения плитками: полученные цветные, остальные приглушены
// с прогрессом — вся сетка видна сразу, без пустых строк «нет данных».
function myBadgesHtml(d) {
  const all = (d.badges || []).slice().sort((a, b) => (b.unlocked ? 1 : 0) - (a.unlocked ? 1 : 0) || (BADGE_RARITY_ORDER[a.rarity] ?? 9) - (BADGE_RARITY_ORDER[b.rarity] ?? 9));
  if (!all.length) return "";
  const won = all.filter(b => b.unlocked).length;
  const tiles = all.map(b => {
    const has = b.target ? Math.max(0, Math.min(b.target, b.current || 0)) : null;
    const pct = b.target ? Math.round((has / b.target) * 100) : 0;
    return `
      <div class="pf-badge${b.unlocked ? " won" : ""} r-${esc(b.rarity || "common")}" title="${esc(b.label)}">
        <span class="ic">${esc(b.icon)}</span>
        <span class="lb">${esc(b.label)}</span>
        ${b.unlocked ? `<span class="pr">получено</span>` : `<span class="pr">${b.target ? `${has} / ${b.target}` : "нет данных"}</span><span class="tr"><i style="width:${pct}%;"></i></span>`}
        ${b.unlocked && b.custom && devModeActive() ? `<button class="icon-btn badge-revoke" data-revoke-badge="${b.id}" title="Отозвать награду">✕</button>` : ""}
      </div>`;
  }).join("");
  return `
    <section class="pf-card">
      <div class="pf-card-head"><h3>Достижения <span class="n">${won} из ${all.length}</span></h3></div>
      <div class="pf-badges">${tiles}</div>
    </section>`;
}

async function fillRecentActivity(root) {
  const box = root.querySelector("#activity-list");
  if (!box) return;
  let d;
  try { d = await apiGet("/me/activity"); } catch (_) { d = null; }
  if (!box.isConnected) return;
  const evs = ((d && d.events) || []).slice(0, 5);
  if (!evs.length) { box.innerHTML = `<div class="pf-quiet">пока тихо — действия по отчётам появятся здесь</div>`; return; }
  box.innerHTML = evs.map(ev => `
    <div class="pf-act"${ev.public_id ? ` data-open-report="${esc(ev.public_id)}"` : ""}>
      <i></i>
      <div><div class="a">${esc(ev.action || "")}${ev.detail ? ` <span>· ${esc(ev.detail)}</span>` : ""}</div>
      <div class="m">${ev.public_id ? `${esc(ev.public_id)} ${esc(ev.title || "")} · ` : ""}${esc(relTime(ev.created_at))}</div></div>
    </div>`).join("");
  box.querySelectorAll("[data-open-report]").forEach(row => {
    row.addEventListener("click", () => openReportDetail(row.dataset.openReport));
  });
}

// Свободные серии для пустого профиля — тот же быстрый фильтр
// «без исполнителя», что и на вкладке «Список». Отдельным запросом
// после отрисовки: профиль не должен ждать его, чтобы показаться.
async function fillIdleSlot(root) {
  const slot = root.querySelector("#idle-slot");
  if (!slot) return;
  let d;
  try {
    d = await apiGet("/reports", { unassigned: 1, page_size: 100 });
  } catch (_) {
    slot.querySelector(".d").textContent = "свободные серии сейчас не посмотреть — нет связи";
    return;
  }
  if (!slot.isConnected) return;
  const free = d.reports || [];
  const total = d.total || free.length;
  if (!total) {
    slot.querySelector(".d").textContent = "свободных серий тоже нет — всё разобрано";
    return;
  }
  const hot = free.filter(isOverdue).length;
  slot.querySelector(".d").innerHTML =
    `${total} ${total === 1 ? "серия" : "серий"} без исполнителя` +
    (hot ? ` · <span style="color:var(--s-stop);">${hot} просрочено</span>` : "");
  const btn = document.createElement("button");
  btn.className = "btn primary idle-go";
  btn.textContent = "Посмотреть";
  btn.addEventListener("click", () => {
    // Если «Список» уже был загружен, switchTab его не перечитает
    // (loadedTabs) — перечитываем сами, иначе фильтр применится только
    // визуально, к чипу.
    const wasLoaded = state.loadedTabs.has("list");
    setQuickFilter("unassigned");
    switchTab("list");
    if (wasLoaded) loadReports();
  });
  slot.appendChild(btn);
}

// Сколько закрывают остальные — чтобы «поставьте себе план» не был
// вопросом в пустоту. Берём уже существующий рейтинг месяца (тот же
// эндпоинт дёргает «Обзор»), считаем средний темп по тем, кто вообще
// закрывал. Не вышло — просто не показываем подсказку.
async function suggestGoal(root) {
  const el = root.querySelector("#goal-pace");
  if (!el) return null;
  try {
    const d = await apiGet("/overview/monthly-top");
    const done = (d.top || []).map(p => p.completed || 0).filter(n => n > 0);
    if (!done.length) return null;
    const avg = Math.max(1, Math.round(done.reduce((a, b) => a + b, 0) / done.length));
    if (!el.isConnected) return avg;
    el.hidden = false;
    el.textContent = `Темп студии за месяц — ${avg} ${avg === 1 ? "серия" : "серий"} на человека.`;
    return avg;
  } catch (_) {
    return null;
  }
}

// Системный тост при первом заходе после того, как цель месяца
// выполнена — а не только цвет кольца, который увидишь лишь если сам
// зашёл на вкладку «Я». Флаг «уже уведомляли в этом месяце» — в
// localStorage (per-machine, не критично разделять между устройствами
// одного человека), ключ включает telegram_id и месяц, чтобы новый
// месяц с той же целью снова мог уведомить.
function notifyGoalReachedIfNeeded(me, goalSet, goalOver, goalDone) {
  if (!goalSet || !goalOver) return;
  const monthKey = new Date().toISOString().slice(0, 7);
  const flagKey = `phoenix_goal_notified_${me.telegram_id}_${monthKey}`;
  try {
    if (localStorage.getItem(flagKey)) return;
    localStorage.setItem(flagKey, "1");
  } catch (_) { return; } // приватный режим/запрет хранилища — не критично, просто без уведомления
  sendNotification({
    title: "PHOENIX DUB",
    body: `Цель месяца выполнена — ${goalDone} из ${me.monthly_goal} отчётов закрыто. 🎯`,
  });
}

function editProfileDialog(me) {
  const overlay = openSheet(`
    <h2>Статус и о себе</h2>
    <div class="row"><input type="text" id="dlg-status" maxlength="80" placeholder="Короткий статус" value="${esc(me.status_text || "")}"></div>
    <div class="row"><textarea id="dlg-bio" rows="3" maxlength="300" placeholder="О себе">${esc(me.bio || "")}</textarea></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-close>Отмена</button>
      <button class="btn primary" id="dlg-apply">Сохранить</button>
    </div>
  `);
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#dlg-apply").addEventListener("click", async () => {
    const status_text = overlay.querySelector("#dlg-status").value;
    const bio = overlay.querySelector("#dlg-bio").value;
    try {
      await apiPost("/me/profile", { status_text, bio });
      toast("Профиль обновлён.");
      overlay.remove();
      await loadProfile();
    } catch (e) {
      toast(`Не удалось сохранить: ${e.message}`, "error");
    }
  });
}

async function openMyActivitySheet() {
  const overlay = openSheet(`<h2>Моя активность</h2>${dialogSkeletonHtml(6)}`);
  const sheet = overlay.querySelector(".sheet");
  let d;
  try {
    d = await apiGet("/me/activity");
  } catch (e) {
    sheet.innerHTML = `<h2>Моя активность</h2><div class="bento-empty">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    return;
  }
  const rows = (d.events || []).map(ev => `
    <div class="note-item" data-open-report="${esc(ev.public_id || "")}" style="${ev.public_id ? "cursor:pointer;" : ""}">
      <div class="meta">${esc(ev.public_id || "")} ${esc(ev.title || "")} · ${esc(ev.created_at || "")}</div>
      <div>${esc(ev.action || "")}${ev.detail ? ` — ${esc(ev.detail)}` : ""}</div>
    </div>
  `).join("");
  sheet.innerHTML = `
    <h2>Моя активность</h2>
    <div>${rows || `<div class="bento-empty">Пока пусто</div>`}</div>
    <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
  `;
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  sheet.querySelectorAll("[data-open-report]").forEach(row => {
    if (row.dataset.openReport) row.addEventListener("click", () => openReportDetail(row.dataset.openReport));
  });
}

function monthlyGoalDialog(current) {
  const overlay = openSheet(`
    <h2>Цель на месяц</h2>
    <p style="color:var(--ink-soft); font-size:12.5px; margin-top:-8px;">Сколько отчётов хотите закрыть в этом месяце. 0 — снять цель.</p>
    <div class="row"><input type="number" id="dlg-goal" min="0" max="500" value="${current || 0}"></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-close>Отмена</button>
      <button class="btn primary" id="dlg-apply">Сохранить</button>
    </div>
  `);
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#dlg-apply").addEventListener("click", async () => {
    const goal = Number(overlay.querySelector("#dlg-goal").value) || 0;
    try {
      await apiPost("/me/goal", { goal });
      toast(goal ? "Цель сохранена." : "Цель снята.");
      overlay.remove();
      await loadProfile();
    } catch (e) {
      toast(`Не удалось сохранить цель: ${e.message}`, "error");
    }
  });
}

// ---------- Команда / чужой профиль ----------

export async function openTeamSheet() {
  const overlay = openSheet(dialogSkeletonHtml(6), "wide");
  overlay.querySelector(".sheet").innerHTML = `<h2>Команда</h2>` + dialogSkeletonHtml(6);
  let d;
  try {
    d = await apiGet("/team");
  } catch (e) {
    overlay.querySelector(".sheet").innerHTML = `<h2>Команда</h2><div class="bento-empty">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    return;
  }
  const rows = (d.users || []).map(u => `
    <div class="team-row" data-open-user="${u.telegram_id}" data-username="${esc(u.username || "")}">
      ${avatarHtml(u.telegram_id, u.name, "sm")}
      <span class="online-dot${u.online ? "" : " off"}"></span>
      <div class="nm"><div class="n">${esc(u.name)}${u.is_owner ? ` <span class="dev-pill">DEV</span>` : ""}</div><div class="r">${esc(u.role || "без роли")}</div></div>
      <div class="stat">${u.assigned} сейчас · ${u.completed_total} закрыто</div>
    </div>
  `).join("");
  overlay.querySelector(".sheet").innerHTML = `
    <h2>Команда · ${d.users.length}</h2>
    <div class="team-list">${rows || `<div class="bento-empty">Пока никого нет.</div>`}</div>
    <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
  `;
  const sheet = overlay.querySelector(".sheet");
  loadAvatars(sheet);
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  sheet.querySelectorAll("[data-open-user]").forEach(row => {
    const telegramId = parseInt(row.dataset.openUser, 10);
    row.addEventListener("click", () => openUserProfile(telegramId));
    // Правый клик — быстрые действия без открытия целого профиля:
    // привычка из проводника/почты, а не только «клик = открыть».
    row.addEventListener("contextmenu", e => {
      e.preventDefault();
      const username = row.dataset.username;
      const items = [{ label: "Открыть профиль", action: () => openUserProfile(telegramId) }];
      if (username) {
        items.push({ label: "Написать в Telegram", action: () => openTelegramProfile(username) });
      }
      items.push({
        label: "Скопировать Telegram ID",
        action: () => {
          navigator.clipboard.writeText(String(telegramId))
            .then(() => toast("ID скопирован."))
            .catch(() => toast("Не удалось скопировать.", "error"));
        },
      });
      showContextMenu(e.clientX, e.clientY, items);
    });
  });
}

// Открыть личный чат в Telegram — во внешнем приложении/браузере
// (plugin:shell|open), а не внутри окна PHOENIX DUB: это desktop-клиент
// студии, не браузер, встраивать чужой веб-клиент Telegram сюда незачем.
async function openTelegramProfile(username) {
  try {
    await openExternal(`https://t.me/${encodeURIComponent(username)}`);
  } catch (e) {
    toast(`Не удалось открыть Telegram: ${e}`, "error");
  }
}

// Экспортирована для вкладки «Команда» (team.js) — та же карточка
// коллеги, что уже открывается кликом по строке в openTeamSheet.
export async function openUserProfile(telegramId) {
  const overlay = openSheet(dialogSkeletonHtml(6), "wide");
  let d;
  let person = null;
  try {
    // Карточка «Работа» (загрузка, пауза, передача дел) — отдельным
    // запросом; на старом сервере без /people профиль просто без неё.
    [d, person] = await Promise.all([apiGet(`/user/${telegramId}`), fetchPerson(telegramId)]);
  } catch (e) {
    overlay.querySelector(".sheet").innerHTML = `<div class="bento-empty">Не удалось загрузить профиль: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    return;
  }
  d.telegram_id = telegramId;
  const reportsHtml = (d.reports && d.reports.length) ? `
    <div class="sec-title" style="margin-top:16px;">Текущие отчёты</div>
    <div class="mini-list">
      ${d.reports.map(r => `<div class="mini-row" data-open-report="${esc(r.public_id)}" style="cursor:pointer;"><span class="name">${esc(r.public_id)} · ${esc(r.title)}</span><span class="val">${esc(r.status_label)}</span></div>`).join("")}
    </div>` : "";

  const sheet = overlay.querySelector(".sheet");
  sheet.innerHTML = `
    ${profileHeaderHtml(d)}
    ${person ? workSectionHtml(person) : ""}
    <div class="bento">${badgesBentoHtml(d, 0)}</div>
    ${person ? "" : reportsHtml}
    ${devModeActive() ? devPanelHtml(d) : ""}
    <div class="sheet-actions">
      ${state.isDeveloper && String(telegramId) !== String(state.telegramId) ? `<button class="btn danger" data-purge-chats title="Только владелец студии">Удалить личные переписки</button><span style="flex:1"></span>` : ""}
      <button class="btn" data-close>Закрыть</button>
    </div>
  `;
  wireProfileCommon(sheet, telegramId, async () => { await openUserProfile(telegramId); overlay.remove(); });
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  sheet.querySelectorAll("[data-open-report]").forEach(row => {
    row.addEventListener("click", () => openReportDetail(row.dataset.openReport));
  });
  if (person) wireWorkSection(sheet, person, async () => { await openUserProfile(telegramId); overlay.remove(); });
  const purgeBtn = sheet.querySelector("[data-purge-chats]");
  if (purgeBtn) purgeBtn.addEventListener("click", async () => {
    if (!confirm(`Удалить ВСЕ личные переписки ${d.name || "этого человека"}? Они сотрутся целиком, у обеих сторон. Общий чат не затронут. Вернуть нельзя.`)) return;
    purgeBtn.disabled = true;
    try {
      const r = await apiPost("/chats/purge-person", { telegram_id: telegramId });
      toast(r.chats ? `Удалено переписок: ${r.chats}, сообщений: ${r.messages}.` : "Личных переписок у человека не было.");
    } catch (e) { toast(e.message, "error"); purgeBtn.disabled = false; }
  });
  if (devModeActive()) wireDevPanel(sheet, telegramId, async () => { await openUserProfile(telegramId); overlay.remove(); }, d.role);
}
