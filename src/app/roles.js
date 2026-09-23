// Роли — то же, что «🎭 Роли» в админ-панели бота (admin/roles.py):
// список ролей, создать роль, назначить человеку роль по умолчанию.
// Из этих ролей собираются пайплайны отчётов (карточка отчёта).
// /api/roles, /api/roles (POST {name}), /api/roles/assign {telegram_id, role}.

import { apiGet, apiPost, openSheet, toast, dialogSkeletonHtml } from "./api.js";
import { esc } from "./utils.js";
import { loadAvatars } from "./profile.js";

let filterRole = null;
let query = "";

function peopleHtml(d) {
  const q = query.trim().toLowerCase();
  const list = d.people
    .filter(p => filterRole === null || (filterRole === "" ? !p.role : p.role === filterRole))
    .filter(p => !q || `${p.name} ${p.username || ""}`.toLowerCase().includes(q))
    .sort((a, b) => (a.role ? 0 : 1) - (b.role ? 0 : 1) || a.name.localeCompare(b.name, "ru"));
  if (!list.length) return `<div class="no-assignee" style="padding:12px;">Никого</div>`;
  return list.map(p => `
    <div class="rl-person">
      <span class="avatar-bubble rl-av" data-avatar-for="${p.telegram_id}">${esc(p.name.charAt(0).toUpperCase())}</span>
      <span class="rl-person-name"><b>${esc(p.name)}</b>${p.username ? `<span>@${esc(p.username)}</span>` : ""}</span>
      <select class="rl-select${p.role ? " has" : ""}" data-rl-person="${p.telegram_id}" aria-label="Роль: ${esc(p.name)}">
        <option value="">без роли</option>
        ${d.roles.map(r => `<option value="${esc(r.name)}"${p.role === r.name ? " selected" : ""}>${esc(r.name)}</option>`).join("")}
      </select>
    </div>`).join("");
}

function rolesHtml(d) {
  const none = d.people.filter(p => !p.role).length;
  const chip = (value, label, count) => `
    <button type="button" class="rl-role${filterRole === value ? " on" : ""}" data-rl-filter="${value === null ? "*" : esc(value)}">
      <span>${esc(label)}</span><b>${count}</b>
    </button>`;
  return chip(null, "Все люди", d.people.length)
    + d.roles.map(r => chip(r.name, r.name, r.people)).join("")
    + chip("", "Без роли", none);
}

export async function openRolesSheet() {
  const overlay = openSheet(`<h2>Роли</h2>${dialogSkeletonHtml(5)}`, "wide");
  const sheet = overlay.querySelector(".sheet");
  sheet.classList.add("rl-sheet");
  let data;

  function render() {
    sheet.innerHTML = `
      <h2>Роли</h2>
      <p class="tn-hint">Роль человека по умолчанию — из неё собираются пайплайны отчётов («Даббер → Звукарь → Редактор»).</p>
      <div class="rl-layout">
        <div class="rl-roles">
          <div class="rl-roles-list">${rolesHtml(data)}</div>
          <form class="rl-create" id="rl-create">
            <input id="rl-new" type="text" maxlength="40" placeholder="Новая роль" aria-label="Название новой роли">
            <button class="btn" type="submit">Создать</button>
          </form>
        </div>
        <div class="rl-people">
          <label class="fd-search rl-search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
            <input type="search" id="rl-q" placeholder="Найти человека" value="${esc(query)}" aria-label="Найти человека">
          </label>
          <div class="rl-people-list" id="rl-people">${peopleHtml(data)}</div>
        </div>
      </div>
      <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    loadAvatars(sheet);
    wirePeople();
    sheet.querySelectorAll("[data-rl-filter]").forEach(b => b.addEventListener("click", () => {
      const v = b.dataset.rlFilter;
      filterRole = v === "*" ? null : v;
      render();
    }));
    sheet.querySelector("#rl-q").addEventListener("input", e => {
      query = e.target.value;
      sheet.querySelector("#rl-people").innerHTML = peopleHtml(data);
      loadAvatars(sheet);
      wirePeople();
    });
    sheet.querySelector("#rl-create").addEventListener("submit", async e => {
      e.preventDefault();
      const name = sheet.querySelector("#rl-new").value.trim();
      if (!name) return;
      try {
        data = await apiPost("/roles", { name });
        toast(`Роль «${name}» создана.`);
        render();
      } catch (err) { toast(err.message, "error"); }
    });
  }

  function wirePeople() {
    sheet.querySelectorAll("[data-rl-person]").forEach(sel => sel.addEventListener("change", async () => {
      sel.disabled = true;
      try {
        data = await apiPost("/roles/assign", { telegram_id: Number(sel.dataset.rlPerson), role: sel.value });
        const who = data.people.find(p => String(p.telegram_id) === sel.dataset.rlPerson);
        toast(sel.value ? `${who ? who.name : ""}: ${sel.value}` : `${who ? who.name : ""}: роль снята`);
        const scroll = sheet.querySelector("#rl-people").scrollTop;
        render();
        sheet.querySelector("#rl-people").scrollTop = scroll;
      } catch (err) {
        toast(err.message, "error");
        sel.disabled = false;
      }
    }));
  }

  try {
    data = await apiGet("/roles");
    render();
  } catch (e) {
    sheet.innerHTML = `<h2>Роли</h2><div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  }
}
