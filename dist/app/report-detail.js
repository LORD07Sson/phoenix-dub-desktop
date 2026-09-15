// Развёрнутая карточка отчёта (шторка): чек-лист, заметки, файлы,
// серверная AI-проверка звука. Открывается из Списка/Доски/Ленты/
// профиля коллеги.

import { apiGet, apiPost, openSheet, toast, dialogSkeletonHtml } from "./api.js";
import { esc, initials, STATUS_DOT_CLASS, isOverdue } from "./utils.js";
import { changeStatusDialog, assignDialog, priorityDialog, deadlineDialog } from "./reports.js";

const QC_FINDING_LABELS_RU = { clipping: "Клиппинг", silence: "Пауза", noise: "Шум", loud: "Громко", quiet: "Тихо" };

export async function openReportDetail(publicId) {
  const overlay = openSheet(`
    <h2 class="skeleton-row" style="width:60%; height:22px;"></h2>
    ${dialogSkeletonHtml(5)}
  `, "wide");

  async function render() {
    let detail, notes, checklist, files;
    try {
      [detail, notes, checklist, files] = await Promise.all([
        apiGet(`/report/${publicId}`),
        apiGet(`/report/${publicId}/notes`),
        apiGet(`/report/${publicId}/checklist`),
        apiGet(`/report/${publicId}/files`),
      ]);
    } catch (e) {
      overlay.querySelector(".sheet").innerHTML = `<div style="color:var(--s-stop);">Не удалось загрузить карточку: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
      overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
      return;
    }

    const dotClass = STATUS_DOT_CLASS[detail.status] || "draft";
    const overdue = isOverdue(detail);

    overlay.querySelector(".sheet").innerHTML = `
      <div class="detail-head">
        <h2>${esc(detail.title)}</h2>
        <button class="icon-btn" data-close style="flex:none;">✕</button>
      </div>
      <div class="detail-id">${esc(detail.public_id)} · от ${esc((detail.author && (detail.author.first_name || detail.author.username)) || "?")} · ${esc(detail.created_at || "")}</div>

      <div class="detail-chips">
        <span class="chip" id="chip-status"><span class="dot ${dotClass}"></span>${esc(detail.status_label)}</span>
        <span class="chip" id="chip-priority">${esc(detail.priority_label)}</span>
        <span class="chip ${overdue ? "" : ""}" id="chip-deadline" style="${overdue ? "border-color:var(--s-stop); color:var(--s-stop);" : ""}">${overdue ? "⏰ " : "📅 "}${esc(detail.deadline || "без срока")}</span>
        <span class="chip" id="chip-assign">👤 Назначить</span>
      </div>

      <div class="detail-section">
        <h3>Исполнители</h3>
        ${(detail.assignees && detail.assignees.length)
          ? detail.assignees.map(a => `<div class="assignee-row"><span class="avatar-bubble">${esc(initials(a.first_name || a.username))}</span>${esc(a.first_name || a.username || `ID ${a.telegram_id}`)}</div>`).join("")
          : `<div class="no-assignee">Никто не назначен</div>`}
      </div>

      <div class="detail-section">
        <h3>Чек-лист ${checklist.items.length ? `(${checklist.items.filter(i => i.done).length}/${checklist.items.length})` : ""}</h3>
        <div id="checklist-list">${checklist.items.map(checklistItemHtml).join("") || `<div class="no-assignee">Пусто</div>`}</div>
        <div class="add-row">
          <input id="checklist-new" placeholder="Новый пункт…">
          <button class="btn" id="checklist-add">+</button>
        </div>
      </div>

      <div class="detail-section">
        <h3>Заметки ${notes.notes.length ? `(${notes.notes.length})` : ""}</h3>
        <div id="notes-list">${notes.notes.map(noteHtml).join("") || `<div class="no-assignee">Пока нет заметок</div>`}</div>
        <div class="add-row">
          <textarea id="note-new" rows="2" placeholder="Написать заметку…"></textarea>
          <button class="btn" id="note-add">Добавить</button>
        </div>
      </div>

      ${files.files.length ? `
      <div class="detail-section">
        <h3>Файлы (${files.files.length})</h3>
        <div id="files-list">${files.files.map(fileHtml).join("")}</div>
      </div>` : ""}

      <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
    `;

    const sheet = overlay.querySelector(".sheet");
    sheet.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => overlay.remove()));
    sheet.querySelector("#chip-status").addEventListener("click", () => changeStatusDialog([publicId], render));
    sheet.querySelector("#chip-assign").addEventListener("click", () => assignDialog([publicId], render));
    sheet.querySelector("#chip-priority").addEventListener("click", () => priorityDialog(publicId, render));
    sheet.querySelector("#chip-deadline").addEventListener("click", () => deadlineDialog(publicId, detail.deadline, render));

    sheet.querySelectorAll(".checklist-item").forEach(el => {
      el.addEventListener("click", async () => {
        try {
          await apiPost(`/report/${publicId}/checklist/${el.dataset.id}/toggle`, {});
          await render();
        } catch (e) { toast(`Не удалось изменить пункт: ${e.message}`, "error"); }
      });
    });
    sheet.querySelector("#checklist-add").addEventListener("click", async () => {
      const input = sheet.querySelector("#checklist-new");
      const text = input.value.trim();
      if (!text) return;
      try {
        await apiPost(`/report/${publicId}/checklist`, { text });
        await render();
      } catch (e) { toast(`Не удалось добавить пункт: ${e.message}`, "error"); }
    });
    sheet.querySelector("#note-add").addEventListener("click", async () => {
      const ta = sheet.querySelector("#note-new");
      const text = ta.value.trim();
      if (!text) return;
      try {
        await apiPost(`/report/${publicId}/notes`, { text });
        await render();
      } catch (e) { toast(`Не удалось добавить заметку: ${e.message}`, "error"); }
    });
    sheet.querySelectorAll("[data-qc-file]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const fileId = btn.dataset.qcFile;
        btn.disabled = true;
        btn.textContent = "Анализ…";
        try {
          const res = await apiPost(`/report/${publicId}/files/${fileId}/qc`, {});
          const resultEl = sheet.querySelector(`#qc-result-${fileId}`);
          const findings = res.findings || [];
          resultEl.innerHTML = findings.length
            ? findings.map(f => `<div class="qc-finding ${f.severity || "warn"}"><span class="tag">${esc(QC_FINDING_LABELS_RU[f.kind] || f.kind || "?")}</span><div>${esc(f.message || "")}</div></div>`).join("")
            : `<div style="color:var(--s-done); font-size:12px;">✓ Замечаний не найдено</div>`;
        } catch (e) {
          toast(`AI-проверка не удалась: ${e.message}`, "error");
        } finally {
          btn.disabled = false;
          btn.textContent = "🤖 AI-проверка";
        }
      });
    });
  }

  await render();
}

function checklistItemHtml(item) {
  return `<div class="checklist-item ${item.done ? "done" : ""}" data-id="${item.id}">
    <input type="checkbox" ${item.done ? "checked" : ""} tabindex="-1">
    <span>${esc(item.text)}</span>
  </div>`;
}

function noteHtml(n) {
  return `<div class="note-item">
    <div class="meta">${esc(n.author)} · ${esc(n.created_at || "")}</div>
    <div>${esc(n.text)}</div>
  </div>`;
}

function fileHtml(f) {
  const isAudio = /audio|wav|mp3|flac|m4a|ogg/i.test(f.file_type || f.file_name || "");
  return `<div class="file-item">
    <div>${esc(f.file_name || f.file_type)} <span class="meta">${esc(f.file_size_label || "")}</span></div>
    ${isAudio ? `<button class="btn" style="padding:4px 10px; font-size:12px;" data-qc-file="${f.id}">🤖 AI-проверка</button>` : ""}
    <div id="qc-result-${f.id}" style="width:100%;"></div>
  </div>`;
}
