// Вкладка «Команда» — сетка карточек участников студии, тот же
// /api/team, что уже питает openTeamSheet (модалку из «Я» — она
// остаётся как есть, это отдельный, более широкий обзорный экран).
// Тегов-специализаций ("Strategy", "Brand" и т.п.) у референса нет
// аналога в данных студии — не выдумываем, вместо них роль и реальные
// счётчики (назначено сейчас / закрыто всего).

import { apiGet } from "./api.js";
import { $, esc } from "./utils.js";
import { avatarHtml, loadAvatars, openUserProfile } from "./profile.js";

function teamCardHtml(u) {
  return `
    <div class="team-card" data-open-user="${u.telegram_id}">
      ${avatarHtml(u.telegram_id, u.name, "xl")}
      <div class="team-card-name">${esc(u.name)}${u.is_owner ? ` <span class="dev-pill">DEV</span>` : ""}</div>
      <div class="team-card-role">${esc(u.role || "без роли")}</div>
      <div class="team-card-foot">
        <span>${u.assigned} сейчас · ${u.completed_total} закрыто</span>
        <span class="team-card-status">
          <span class="online-dot${u.online ? "" : " off"}"></span>${u.online ? "Онлайн" : "Офлайн"}
        </span>
      </div>
    </div>
  `;
}

function teamHtml(d) {
  const users = d.users || [];
  const cards = users.map(teamCardHtml).join("");
  return `
    <div class="page-header">
      <div>
        <h1>Команда</h1>
        <div class="sub">Все, кто сейчас работает над сериями студии.</div>
      </div>
    </div>
    <div class="team-grid">${cards || `<div class="bento-empty">Пока никого нет.</div>`}</div>
  `;
}

export async function loadTeam() {
  const root = $("#team-body");
  root.innerHTML = `<div class="skeleton-wrap"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`;
  let d;
  try {
    d = await apiGet("/team");
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить команду: ${esc(e.message)}</div>`;
    return false;
  }
  root.innerHTML = teamHtml(d);
  loadAvatars(root);
  root.querySelectorAll("[data-open-user]").forEach(card => {
    const telegramId = parseInt(card.dataset.openUser, 10);
    card.addEventListener("click", () => openUserProfile(telegramId));
  });
}
