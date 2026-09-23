// Вкладка «Команда» — сводка, фильтры и люди, сгруппированные по
// ролям. Тот же /api/team, что питает openTeamSheet (модалку из «Я»).
// Необязательные поля сервера (current, completed_month, paused_until)
// показываются, когда он их отдаёт; без них карточка просто короче.

import { apiGet } from "./api.js";
import { state } from "./state.js";
import { $, esc } from "./utils.js";
import { avatarHtml, loadAvatars, openUserProfile } from "./profile.js";
import { openRolesSheet } from "./roles.js";
import { switchTab } from "./tabs.js";
import { openDmWith } from "./messages.js";

// «user» — служебное значение по умолчанию в базе, а не роль.
const roleOf = u => (u.role && u.role.toLowerCase() !== "user" ? u.role : "");

const FILTERS = [
  ["all", "Все"],
  ["online", "В сети"],
  ["busy", "С серией"],
  ["free", "Свободны"],
  ["paused", "На паузе"],
];

let teamData = null;
let filter = "all";
let query = "";
let roleFilter = ""; // "" — все роли, "—" — без роли

function roleChipsHtml(users) {
  const counts = new Map();
  for (const u of users) {
    const k = roleOf(u) || "—";
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const keys = [...counts.keys()].sort((a, b) => (a === "—") - (b === "—") || a.localeCompare(b, "ru"));
  return keys.map(k => `<button class="tm-rchip${k === roleFilter ? " active" : ""}${k === "—" ? " none" : ""}" data-tm-role="${esc(k)}">${k === "—" ? "без роли" : esc(k)} <span>${counts.get(k)}</span></button>`).join("");
}

function fmtDay(iso) {
  const [, m, d] = String(iso).slice(0, 10).split("-");
  return d && m ? `${d}.${m}` : iso;
}

function matches(u) {
  if (query && !`${u.name} ${u.username || ""} ${roleOf(u)}`.toLowerCase().includes(query)) return false;
  if (filter === "online") return u.online;
  if (filter === "busy") return u.assigned > 0;
  if (filter === "free") return !u.assigned && !u.paused_until;
  if (filter === "paused") return !!u.paused_until;
  return true;
}

function personHtml(u, maxLoad) {
  const role = roleOf(u);
  const load = maxLoad ? Math.round((u.assigned / maxLoad) * 100) : 0;
  const work = u.paused_until
    ? `<span class="tm-state paused">в отпуске до ${esc(fmtDay(u.paused_until))}</span>`
    : u.assigned
      ? `<span class="tm-state busy" title="${esc(u.current || "")}">${u.current ? `на руках: ${esc(u.current)}` : `на руках ${u.assigned}`}</span>`
      : `<span class="tm-state free">свободен</span>`;
  return `
    <div class="tm-card${u.online ? " on" : ""}${u.paused_until ? " paused" : ""}" data-open-user="${u.telegram_id}">
      <span class="tm-av">${avatarHtml(u.telegram_id, u.name, "xl")}${u.online ? `<i class="tm-dot" title="В сети"></i>` : ""}</span>
      <div class="tm-who">
        <div class="tm-name">${esc(u.name)}${u.is_owner ? ` <span class="dev-pill">DEV</span>` : ""}</div>
        <div class="tm-role${role ? "" : " none"}">${role ? esc(role) : "без роли"}</div>
      </div>
      ${work}
      <div class="tm-load" title="Серий на руках: ${u.assigned}"><i style="width:${load}%"></i></div>
      <div class="tm-foot">
        <span><b>${u.assigned}</b> сейчас</span>
        <span><b>${u.completed_month ?? u.completed_total}</b> ${u.completed_month != null ? "за месяц" : "закрыто"}</span>
      </div>
      <div class="tm-actions">
        <button class="tm-act" data-tm-msg="${u.telegram_id}" title="Написать в «Сообщения»">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 4V5Z"/></svg></button>
        <button class="tm-act" data-tm-open="${u.telegram_id}" title="Профиль">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/></svg></button>
      </div>
    </div>`;
}

// Одна плотная сетка: сначала те, кто в сети, потом занятые, дальше по
// роли — чтобы люди с ролью шли рядом, а «без роли» собирались в конце.
function rank(u) {
  return [u.online ? 0 : 1, u.assigned ? 0 : 1, roleOf(u) ? 0 : 1, roleOf(u), u.name];
}
function byRank(a, b) {
  const ra = rank(a), rb = rank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] < rb[i]) return -1;
    if (ra[i] > rb[i]) return 1;
  }
  return 0;
}

function renderPeople(root) {
  const users = (teamData.users || []).filter(u => matches(u) && (!roleFilter || (roleOf(u) || "—") === roleFilter)).sort(byRank);
  const maxLoad = Math.max(1, ...(teamData.users || []).map(u => u.assigned || 0));
  const host = root.querySelector("#tm-groups");
  const noRole = roleFilter === "—" && state.isAdmin ? `<div class="tm-hint">Роль видна на карточке и в пайплайне. <button class="pf-link" data-tm-roles>Назначить роли →</button></div>` : "";
  host.innerHTML = users.length
    ? `${noRole}<div class="tm-grid">${users.map(u => personHtml(u, maxLoad)).join("")}</div>`
    : `<div class="bento-empty">Никого не нашлось — попробуйте другой фильтр.</div>`;
  loadAvatars(host);
  host.querySelectorAll("[data-open-user]").forEach(card => {
    card.addEventListener("click", () => openUserProfile(parseInt(card.dataset.openUser, 10)));
  });
  host.querySelectorAll("[data-tm-open]").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    openUserProfile(parseInt(b.dataset.tmOpen, 10));
  }));
  host.querySelectorAll("[data-tm-msg]").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    openDmWith(parseInt(b.dataset.tmMsg, 10));
    switchTab("messages");
  }));
  host.querySelector("[data-tm-roles]")?.addEventListener("click", openRolesSheet);
}

function teamHtml(d) {
  const users = d.users || [];
  const online = users.filter(u => u.online).length;
  const busy = users.filter(u => u.assigned > 0).length;
  const paused = users.filter(u => u.paused_until).length;
  const free = users.filter(u => !u.assigned && !u.paused_until).length;
  const stat = (n, l, cls) => `<div class="tm-stat ${cls || ""}"><b>${n}</b><span>${l}</span></div>`;
  return `
    <div class="page-header">
      <div>
        <h1>Команда</h1>
        <div class="sub">Кто в студии, кто чем занят и кто свободен.</div>
      </div>
      <div class="page-header-actions">
        <button class="btn" id="team-roles-btn"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 11l2 2 4-4"/></svg>Роли</button>
      </div>
    </div>
    <div class="tm-stats">
      ${stat(users.length, "в команде")}
      ${stat(online, "в сети", "on")}
      ${stat(busy, "с серией на руках", "busy")}
      ${stat(free, "свободны", "free")}
      ${paused ? stat(paused, "на паузе", "paused") : ""}
    </div>
    <div class="tm-bar">
      <div class="tm-chips">${FILTERS.map(([k, l]) => `<button class="qf-chip${k === filter ? " active" : ""}" data-tm-filter="${k}">${l}</button>`).join("")}</div>
      <input class="tm-search" id="tm-search" type="search" placeholder="Имя или роль…" value="${esc(query)}">
    </div>
    <div class="tm-roles">${roleChipsHtml(users)}</div>
    <div id="tm-groups"></div>
  `;
}

export async function loadTeam() {
  const root = $("#team-body");
  root.innerHTML = `<div class="skeleton-wrap"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`;
  try {
    teamData = await apiGet("/team");
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить команду: ${esc(e.message)}</div>`;
    return false;
  }
  root.innerHTML = teamHtml(teamData);
  renderPeople(root);
  const rolesBtn = root.querySelector("#team-roles-btn");
  if (state.isAdmin) rolesBtn.addEventListener("click", openRolesSheet); else rolesBtn.remove();
  root.querySelectorAll("[data-tm-filter]").forEach(b => b.addEventListener("click", () => {
    filter = b.dataset.tmFilter;
    root.querySelectorAll("[data-tm-filter]").forEach(x => x.classList.toggle("active", x === b));
    renderPeople(root);
  }));
  root.querySelectorAll("[data-tm-role]").forEach(b => b.addEventListener("click", () => {
    roleFilter = roleFilter === b.dataset.tmRole ? "" : b.dataset.tmRole;
    root.querySelectorAll("[data-tm-role]").forEach(x => x.classList.toggle("active", x.dataset.tmRole === roleFilter));
    renderPeople(root);
  }));
  root.querySelector("#tm-search").addEventListener("input", e => {
    query = e.target.value.trim().toLowerCase();
    renderPeople(root);
  });
}
