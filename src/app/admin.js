// Админ-панель — доступ (allowed_users), заявки на доступ, заявки
// владельцу на подтверждение (только owner), тикеты поддержки,
// состояние системы. Портировано из openSettingsSheet/openAccessSheet/
// openOwnerRequestsSheet/openTicketsSheet мини-аппа (miniapp/static/
// index.html) — тот же набор /api/admin/*, /api/access-requests,
// /api/owner/requests, /api/tickets. Desktop-клиент открыт только
// админам (пара по коду выдаётся боту через /desktop — обычным
// пользователям взять его неоткуда), поэтому, в отличие от мини-аппа,
// отдельного условия "только для админов" на кнопку не нужно — сервер
// всё равно перепроверяет каждый вызов через _require_admin/_require_owner.

import { apiGet, apiPost, apiDelete, openSheet, toast, dialogSkeletonHtml } from "./api.js";
import { esc } from "./utils.js";
import { avatarHtml, loadAvatars } from "./profile.js";

function fmtBytes(n) {
  if (n == null) return "—";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + " " + units[i];
}

function accessRowHtml(u) {
  const tag = u.is_owner ? ` <span class="dev-pill">DEV</span>` : (u.is_admin ? ` <span class="role-tag" style="--tag-c:var(--gold)">админ</span>` : "");
  return `<div class="mini-row">
    ${avatarHtml(u.telegram_id, u.name, "sm")}
    <span class="name">${esc(u.name || `ID ${u.telegram_id}`)}${tag}</span>
    <span class="val" style="font-family:ui-monospace,'SF Mono',monospace;">${u.telegram_id}</span>
    ${u.is_admin ? "" : `<button class="qchip" data-access-revoke="${u.telegram_id}">Отозвать</button>`}
  </div>`;
}

export async function openAdminPanel() {
  const overlay = openSheet(`<h2>Админ-панель</h2>${dialogSkeletonHtml(6)}`, "wide");
  const sheet = overlay.querySelector(".sheet");

  async function refreshAccess() {
    const slot = sheet.querySelector("#admin-access-slot");
    if (!slot) return;
    try {
      const res = await apiGet("/admin/access");
      slot.innerHTML = `
        <h3>Доступ (${res.users.length})</h3>
        ${res.users.length ? res.users.map(accessRowHtml).join("") : `<div class="no-assignee">Список пуст</div>`}
        <div class="add-row" style="margin-top:8px;">
          <input type="number" id="access-add-id" placeholder="telegram_id, например 123456789">
          <button class="btn" id="access-add-btn">Выдать</button>
        </div>
      `;
      loadAvatars(slot);
      slot.querySelectorAll("[data-access-revoke]").forEach(btn => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.accessRevoke;
          if (!confirm(`Отозвать доступ у ${id}?`)) return;
          btn.disabled = true;
          try {
            const r = await apiDelete(`/admin/access/${id}`);
            toast(r.removed ? "Доступ отозван." : (r.pending_approval ? "Отправлено владельцу на подтверждение." : "Не удалось отозвать."));
            await refreshAccess();
          } catch (e) { toast(`Не удалось отозвать: ${e.message}`, "error"); btn.disabled = false; }
        });
      });
      slot.querySelector("#access-add-btn").addEventListener("click", async () => {
        const input = slot.querySelector("#access-add-id");
        const id = parseInt(input.value, 10);
        if (!id) { toast("Введите telegram_id числом.", "error"); return; }
        try {
          const r = await apiPost("/admin/access", { telegram_id: id });
          toast(r.added ? "Доступ выдан." : (r.pending_approval ? "Отправлено владельцу на подтверждение." : "Уже был допущен."));
          await refreshAccess();
        } catch (e) { toast(`Не удалось выдать: ${e.message}`, "error"); }
      });
    } catch (e) {
      slot.innerHTML = `<div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div>`;
    }
  }

  async function refreshSystem() {
    const slot = sheet.querySelector("#admin-system-slot");
    const reqSlot = sheet.querySelector("#admin-requests-slot");
    if (!slot) return;
    try {
      const s = await apiGet("/admin/system");
      const ffmpegOk = s.ffmpeg_available && s.ffprobe_available;
      slot.innerHTML = `
        <div class="mini-row"><span class="name">🗄 Схема базы</span><span class="val">${s.schema_version}/${s.schema_total}${s.schema_up_to_date ? "" : " ⚠️"}</span></div>
        <div class="mini-row"><span class="name">💾 Размер базы</span><span class="val">${esc(fmtBytes(s.db_size_bytes))}</span></div>
        <div class="mini-row"><span class="name">🎬 ffmpeg/ffprobe</span><span class="val">${ffmpegOk ? "✓ OK" : "⚠️ нет"}</span></div>
        <div class="mini-row"><span class="name">🔐 Допущено</span><span class="val">${s.allowed_users_count}</span></div>
      `;
      if (reqSlot) {
        reqSlot.innerHTML = `
          <button class="btn" id="btn-open-tickets" style="width:100%; justify-content:center; margin-bottom:8px;">Открытые тикеты</button>
          <button class="btn" id="btn-open-access-requests" style="width:100%; justify-content:center;">Заявки на доступ${s.pending_access_requests ? ` · ${s.pending_access_requests}` : ""}</button>
          ${s.is_owner ? `<button class="btn" id="btn-open-owner-requests" style="width:100%; justify-content:center; margin-top:8px;">На подтверждении${s.pending_owner_requests ? ` · ${s.pending_owner_requests}` : ""}</button>` : ""}
        `;
        reqSlot.querySelector("#btn-open-tickets").addEventListener("click", openTicketsSheet);
        reqSlot.querySelector("#btn-open-access-requests").addEventListener("click", openAccessRequestsSheet);
        const ownerBtn = reqSlot.querySelector("#btn-open-owner-requests");
        if (ownerBtn) ownerBtn.addEventListener("click", openOwnerRequestsSheet);
      }
    } catch (e) {
      slot.innerHTML = `<div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div>`;
    }
  }

  sheet.innerHTML = `
    <h2>Админ-панель</h2>
    <div class="detail-section"><div id="admin-access-slot">${dialogSkeletonHtml(3)}</div></div>
    <div class="detail-section"><h3>Заявки</h3><div id="admin-requests-slot">${dialogSkeletonHtml(2)}</div></div>
    <div class="detail-section"><h3>Система</h3><div id="admin-system-slot">${dialogSkeletonHtml(4)}</div></div>
    <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
  `;
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  await Promise.all([refreshAccess(), refreshSystem()]);
}

async function openTicketsSheet() {
  const overlay = openSheet(`<h2>Открытые тикеты</h2>${dialogSkeletonHtml(4)}`);
  const sheet = overlay.querySelector(".sheet");
  try {
    const d = await apiGet("/tickets");
    const rows = (d.tickets || []).map(t => `
      <div class="note-item">
        <div class="meta">${esc(t.name)} · #${t.id}</div>
        <div>${esc(t.last_message || "без сообщений")}</div>
      </div>
    `).join("");
    sheet.innerHTML = `
      <h2>Открытые тикеты</h2>
      <div>${rows || `<div class="no-assignee">Открытых тикетов нет</div>`}</div>
      <p style="color:var(--ink-soft); font-size:12px;">Ответить можно в самом боте, в разделе поддержки.</p>
      <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
    `;
  } catch (e) {
    sheet.innerHTML = `<h2>Открытые тикеты</h2><div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
  }
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
}

async function openAccessRequestsSheet() {
  const overlay = openSheet(`<h2>Заявки на доступ</h2>${dialogSkeletonHtml(4)}`);
  const sheet = overlay.querySelector(".sheet");

  async function render() {
    let d;
    try {
      d = await apiGet("/access-requests");
    } catch (e) {
      sheet.innerHTML = `<h2>Заявки на доступ</h2><div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
      sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
      return;
    }
    const rows = (d.requests || []).map(r => `
      <div class="note-item" data-req="${r.id}">
        <div class="meta">${esc(r.name)}${r.username ? ` · @${esc(r.username)}` : ""} · ID ${r.telegram_id}</div>
        <div class="sheet-actions" style="margin-top:6px;">
          <button class="btn primary" data-approve="${r.id}">Впустить</button>
          <button class="btn ghost" data-deny="${r.id}">Отклонить</button>
        </div>
      </div>
    `).join("");
    sheet.innerHTML = `
      <h2>Заявки на доступ</h2>
      <div>${rows || `<div class="no-assignee">Нет ожидающих заявок</div>`}</div>
      <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
    `;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    sheet.querySelectorAll("[data-approve]").forEach(btn => btn.addEventListener("click", () => resolve(btn.dataset.approve, "approve", btn)));
    sheet.querySelectorAll("[data-deny]").forEach(btn => btn.addEventListener("click", () => resolve(btn.dataset.deny, "deny", btn)));
  }

  async function resolve(id, decision, btn) {
    const row = btn.closest(".note-item");
    row.querySelectorAll("button").forEach(b => b.disabled = true);
    try {
      const res = await apiPost(`/access-requests/${id}/resolve`, { decision });
      toast(res.detail || (res.resolved ? "Готово." : "Отправлено."));
      await render();
    } catch (e) {
      toast(`Не удалось: ${e.message}`, "error");
      row.querySelectorAll("button").forEach(b => b.disabled = false);
    }
  }

  await render();
}

const OWNER_REQ_ICONS = { delete_report: "🗑", approve_request: "✅", grant_access: "🔓", revoke_access: "⛔" };

async function openOwnerRequestsSheet() {
  const overlay = openSheet(`<h2>На подтверждении</h2>${dialogSkeletonHtml(4)}`);
  const sheet = overlay.querySelector(".sheet");

  async function render() {
    let d;
    try {
      d = await apiGet("/owner/requests");
    } catch (e) {
      sheet.innerHTML = `<h2>На подтверждении</h2><div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
      sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
      return;
    }
    const rows = (d.requests || []).map(r => `
      <div class="note-item" data-req="${r.id}">
        <div class="meta">${OWNER_REQ_ICONS[r.action_type] || "❔"} ${esc(r.label)} · от ${esc(r.requested_by_name)}</div>
        <div>${esc(r.description || r.target || "")}</div>
        <div class="sheet-actions" style="margin-top:6px;">
          <button class="btn primary" data-approve="${r.id}">Разрешить</button>
          <button class="btn ghost" data-deny="${r.id}">Отклонить</button>
        </div>
      </div>
    `).join("");
    sheet.innerHTML = `
      <h2>На подтверждении</h2>
      <p style="color:var(--ink-soft); font-size:12px; margin-top:-8px;">Действия, которые обычные админы просят подтвердить — только вы это видите.</p>
      <div>${rows || `<div class="no-assignee">Нет заявок от админов</div>`}</div>
      <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
    `;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    sheet.querySelectorAll("[data-approve]").forEach(btn => btn.addEventListener("click", () => resolve(btn.dataset.approve, "approve", btn)));
    sheet.querySelectorAll("[data-deny]").forEach(btn => btn.addEventListener("click", () => resolve(btn.dataset.deny, "deny", btn)));
  }

  async function resolve(id, decision, btn) {
    const row = btn.closest(".note-item");
    row.querySelectorAll("button").forEach(b => b.disabled = true);
    try {
      const res = await apiPost(`/owner/requests/${id}/resolve`, { decision });
      toast(res.detail || "Готово.");
      await render();
    } catch (e) {
      toast(`Не удалось: ${e.message}`, "error");
      row.querySelectorAll("button").forEach(b => b.disabled = false);
    }
  }

  await render();
}
