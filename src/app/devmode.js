// Режим разработчика (/api/dev/*, только для owner) — тумблер хранится
// в localStorage, как и в мини-аппе: чисто косметическое переключение,
// что показать (панель правки на карточке). Авторизацию на КАЖДОЕ
// действие сервер всё равно проверяет заново по OWNER_IDS
// (_require_owner) — фронту тут доверять нельзя.

import { state } from "./state.js";
import { apiGet, apiPost, toast } from "./api.js";
import { esc } from "./utils.js";

const DEV_MODE_KEY = "phoenix-dev-mode";

export function isDevModeOn() {
  try { return localStorage.getItem(DEV_MODE_KEY) === "1"; } catch (_) { return false; }
}
export function setDevModeOn(on) {
  try { localStorage.setItem(DEV_MODE_KEY, on ? "1" : "0"); } catch (_) {}
}
export function devModeActive() { return !!state.isDeveloper && isDevModeOn(); }

let META_ROLES = null;
async function loadMetaRoles() {
  if (META_ROLES) return META_ROLES;
  try { META_ROLES = (await apiGet("/meta")).roles || []; } catch (_) { META_ROLES = []; }
  return META_ROLES;
}

export function devPanelHtml(d) {
  return `
    <div class="sec-title" style="margin-top:16px;">🛠 Служебные данные</div>
    <div class="dev-bento">
      <div class="dev-bcell wide">
        <div class="h">Идентификаторы</div>
        <div class="ro-line"><span>telegram_id</span><b>${d.telegram_id}</b></div>
        <div class="ro-line"><span>internal id</span><b>${d.internal_id != null ? d.internal_id : "—"}</b></div>
        <div class="ro-line"><span>в базе с</span><b style="font-family:inherit; font-weight:400;">${esc(d.created_at || "—")}</b></div>
      </div>
      <div class="dev-bcell wide">
        <div class="h">Роль</div>
        <select id="dev-role-select" class="field-input"><option value="">— загрузка…</option></select>
        <button id="dev-role-save" class="dev-save-btn">Сохранить роль</button>
      </div>
      <div class="dev-bcell wide">
        <div class="h">Статус и о себе</div>
        <input type="text" id="dev-status-input" class="field-input" maxlength="80" placeholder="Короткий статус" value="${esc(d.status_text || "")}">
        <textarea id="dev-bio-input" class="field-textarea" maxlength="300" placeholder="О себе">${esc(d.bio || "")}</textarea>
        <button id="dev-profile-save" class="dev-save-btn">Сохранить профиль</button>
      </div>
      <div class="dev-bcell">
        <div class="h">Дата вступления</div>
        <input type="date" id="dev-joined-input" class="field-input" value="${esc((d.created_at || "").slice(0, 10))}">
        <button id="dev-joined-save" class="dev-save-btn">Сохранить</button>
      </div>
      <div class="dev-bcell">
        <div class="h">Выдать награду</div>
        <div class="dev-badge-row">
          <input type="text" id="dev-badge-icon" class="field-input" placeholder="🐉" maxlength="8">
          <input type="text" id="dev-badge-label" class="field-input" placeholder="Название" maxlength="60">
        </div>
        <button id="dev-badge-grant" class="dev-save-btn">Выдать</button>
      </div>
    </div>
  `;
}

export function wireDevPanel(root, telegramId, onSaved) {
  loadMetaRoles().then(roles => {
    const sel = root.querySelector("#dev-role-select");
    if (!sel) return;
    sel.innerHTML = `<option value="">— без роли —</option>` + roles.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join("");
  });

  const roleBtn = root.querySelector("#dev-role-save");
  if (roleBtn) roleBtn.addEventListener("click", async () => {
    const role = root.querySelector("#dev-role-select").value;
    roleBtn.disabled = true;
    try {
      await apiPost(`/dev/user/${telegramId}/role`, { role });
      toast("Роль обновлена.");
      if (onSaved) await onSaved();
    } catch (e) { toast(`Не удалось сохранить роль: ${e.message}`, "error"); }
    finally { roleBtn.disabled = false; }
  });

  const profileBtn = root.querySelector("#dev-profile-save");
  if (profileBtn) profileBtn.addEventListener("click", async () => {
    const status_text = root.querySelector("#dev-status-input").value;
    const bio = root.querySelector("#dev-bio-input").value;
    profileBtn.disabled = true;
    try {
      await apiPost(`/dev/user/${telegramId}/profile`, { status_text, bio });
      toast("Профиль обновлён.");
      if (onSaved) await onSaved();
    } catch (e) { toast(`Не удалось сохранить профиль: ${e.message}`, "error"); }
    finally { profileBtn.disabled = false; }
  });

  const joinedBtn = root.querySelector("#dev-joined-save");
  if (joinedBtn) joinedBtn.addEventListener("click", async () => {
    const date = root.querySelector("#dev-joined-input").value;
    if (!date) { toast("Укажите дату.", "error"); return; }
    joinedBtn.disabled = true;
    try {
      await apiPost(`/dev/user/${telegramId}/joined`, { date });
      toast("Дата вступления обновлена.");
      if (onSaved) await onSaved();
    } catch (e) { toast(`Не удалось сохранить дату: ${e.message}`, "error"); }
    finally { joinedBtn.disabled = false; }
  });

  const badgeBtn = root.querySelector("#dev-badge-grant");
  if (badgeBtn) badgeBtn.addEventListener("click", async () => {
    const icon = root.querySelector("#dev-badge-icon").value || "🏅";
    const label = root.querySelector("#dev-badge-label").value.trim();
    if (!label) { toast("Нужно название награды.", "error"); return; }
    badgeBtn.disabled = true;
    try {
      await apiPost(`/dev/user/${telegramId}/badge`, { icon, label });
      toast("Награда выдана.");
      if (onSaved) await onSaved();
    } catch (e) { toast(`Не удалось выдать награду: ${e.message}`, "error"); }
    finally { badgeBtn.disabled = false; }
  });
}
