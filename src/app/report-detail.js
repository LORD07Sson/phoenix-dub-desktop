// Развёрнутая карточка отчёта (шторка): чек-лист, заметки, файлы,
// серверная AI-проверка звука. Открывается из Списка/Доски/Ленты/
// профиля коллеги.

import { apiGet, apiPost, openSheet, toast, dialogSkeletonHtml } from "./api.js";
import { state } from "./state.js";
import { invoke, saveDialog, openDialog } from "./tauri.js";
import { esc, initials, STATUS_DOT_CLASS, isOverdue, parseNoteTime, secondsFromTimeInput, noteTimePrefix } from "./utils.js";
import { runQcAnalysis, QC_EXTENSIONS } from "./qc.js";
import { changeStatusDialog, assignDialog, priorityDialog, deadlineDialog, loadReports } from "./reports.js";
import { loadRoles, loadAssignable, userOptionsHtml } from "./titles-admin.js";
import { setDropTarget } from "./file-drop.js";

const QC_FINDING_LABELS_RU = { clipping: "Клиппинг", silence: "Пауза", noise: "Шум", loud: "Громко", quiet: "Тихо" };
const FILE_ICONS = { photo: "🖼", video: "🎬", audio: "🎵", voice: "🎙", document: "📄" };

export async function openReportDetail(publicId) {
  const overlay = openSheet(`
    <h2 class="skeleton-row" style="width:60%; height:22px;"></h2>
    ${dialogSkeletonHtml(5)}
  `, "wide");

  // Пока эта карточка открыта — сюда падает файл, перетащенный из
  // проводника (см. file-drop.js). Снимаем цель при закрытии ЛЮБЫМ
  // способом (кнопка, фон, ✕) — наблюдаем за удалением overlay из DOM,
  // а не вешаем на каждую отдельную кнопку закрытия (тот же приём, что
  // и в titles-admin.js).
  setDropTarget(publicId);
  const onFileUploaded = e => { if (e.detail.publicId === publicId) render(); };
  document.addEventListener("report-file-uploaded", onFileUploaded);
  // Находки QC, уехавшие в заметки, должны появиться в открытой карточке
  // сразу, а не после ручного обновления.
  document.addEventListener("report-notes-added", onFileUploaded);
  // Порядок заметок — состояние самой шторки, а не сервера: render()
  // вызывается на каждое действие, и сбрасывать выбор на каждом было бы
  // неприятно.
  let notesByTime = false;
  new MutationObserver((_muts, obs) => {
    if (!overlay.isConnected) {
      obs.disconnect();
      setDropTarget(null);
      document.removeEventListener("report-file-uploaded", onFileUploaded);
      document.removeEventListener("report-notes-added", onFileUploaded);
    }
  }).observe(document.body, { childList: true });

  async function render() {
    let detail, notes, checklist, files, roles, assignable;
    try {
      [detail, notes, checklist, files, roles, assignable] = await Promise.all([
        apiGet(`/report/${publicId}`),
        apiGet(`/report/${publicId}/notes`),
        apiGet(`/report/${publicId}/checklist`),
        apiGet(`/report/${publicId}/files`),
        loadRoles(),
        loadAssignable(),
      ]);
    } catch (e) {
      overlay.querySelector(".sheet").innerHTML = `<div style="color:var(--s-stop);">Не удалось загрузить карточку: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
      overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
      return;
    }

    // Черновик цепочки пайплайна — правится локально до нажатия
    // «Сохранить», как и в мини-аппе (pipelineDraft): полный список
    // шагов уходит на /pipeline разом, PATCH одного шага сервер не
    // умеет. Сбрасывается при каждом render() (в т.ч. после сохранения
    // заметки/чек-листа отчёта) — то же поведение, что и там.
    let pipelineDraft = (detail.pipeline || []).map(s => ({ role: s.role, telegram_id: s.telegram_id || null, name: s.user_name || null }));

    const dotClass = STATUS_DOT_CLASS[detail.status] || "draft";
    const overdue = isOverdue(detail);

    // Заметки с тайм-кодом — это список правок по дорожке, и читать его
    // удобнее по времени, а не по времени написания.
    const timedCount = notes.notes.filter(n => parseNoteTime(n.text)).length;
    const orderedNotes = notesByTime
      ? notes.notes.slice().sort((a, b) => {
          const ta = parseNoteTime(a.text), tb = parseNoteTime(b.text);
          if (ta && tb) return ta.seconds - tb.seconds;
          if (ta) return -1;
          if (tb) return 1;
          return 0;
        })
      : notes.notes;

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
          ? detail.assignees.map(a => `<div class="assignee-row" data-assignee="${a.telegram_id}">
              <span class="avatar-bubble">${esc(initials(a.first_name || a.username))}</span>
              <span style="flex:1;">${esc(a.first_name || a.username || `ID ${a.telegram_id}`)}</span>
              <button class="icon-btn" data-unassign="${a.telegram_id}" title="Снять">✕</button>
            </div>`).join("")
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
        <h3>Заметки ${notes.notes.length ? `(${notes.notes.length})` : ""}
          ${timedCount >= 2 ? `<button class="btn ghost notes-sort" id="notes-sort">${notesByTime ? "По времени добавления" : "По тайм-коду"}</button>` : ""}
        </h3>
        <div id="notes-list">${orderedNotes.map(noteHtml).join("") || `<div class="no-assignee">Пока нет заметок</div>`}</div>
        <div class="add-row note-add-row">
          <input id="note-time" class="note-time-input" placeholder="04:12" maxlength="8" inputmode="numeric" title="Время на дорожке — необязательно">
          <textarea id="note-new" rows="2" placeholder="Написать заметку…"></textarea>
          <button class="btn" id="note-add">Добавить</button>
        </div>
      </div>

      ${files.files.length ? `
      <div class="detail-section">
        <h3>Файлы (${files.files.length})</h3>
        <div id="files-list">${files.files.map(fileHtml).join("")}</div>
      </div>` : ""}

      <div class="detail-section">
        <h3>Пайплайн ${detail.pipeline && detail.pipeline.length ? `<span style="color:var(--ink-dim); font-weight:400; font-size:12px;">${detail.pipeline.map(s => esc(s.role)).join(" → ")}</span>` : ""}</h3>
        ${pipelineChainHtml(detail.pipeline, assignable)}
        <div id="pipeline-draft-list"></div>
        <div class="add-row">
          <select id="pipeline-role-pick" class="field-input"><option value="">+ роль…</option>${roles.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join("")}</select>
          <select id="pipeline-user-pick" class="field-input">${userOptionsHtml(assignable, null)}</select>
          <button class="btn" id="pipeline-add-step">+</button>
        </div>
        <div class="sheet-actions" style="margin-top:8px;">
          <button class="btn primary" id="btn-pipeline-save">🔗 Сохранить пайплайн</button>
          ${detail.pipeline && detail.pipeline.length ? `<button class="btn danger" id="btn-pipeline-clear">✕ Снять</button>` : ""}
        </div>
      </div>

      <div class="detail-section">
        <div style="display:flex; gap:8px;">
          <button class="btn ghost" id="btn-qc-track" style="flex:1;">🎧 QC дорожки</button>
          <button class="btn ghost" id="btn-history" style="flex:1;">🕓 История</button>
          <button class="btn ghost" id="btn-activity" style="flex:1;">📜 Активность</button>
        </div>
      </div>

      <div class="sheet-actions">
        <button class="btn danger" id="btn-delete-report" style="margin-right:auto;">🗑 Удалить отчёт</button>
        <button class="btn" data-close>Закрыть</button>
      </div>
    `;

    const sheet = overlay.querySelector(".sheet");
    sheet.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => overlay.remove()));
    sheet.querySelector("#chip-status").addEventListener("click", () => changeStatusDialog([publicId], render, detail.status));
    sheet.querySelector("#chip-assign").addEventListener("click", () => assignDialog([publicId], render));
    sheet.querySelector("#chip-priority").addEventListener("click", () => priorityDialog(publicId, render, detail.priority));
    sheet.querySelector("#chip-deadline").addEventListener("click", () => deadlineDialog(publicId, detail.deadline, render));

    sheet.querySelectorAll(".checklist-item").forEach(el => {
      el.addEventListener("click", async () => {
        try {
          await apiPost(`/report/${publicId}/checklist/${el.dataset.id}/toggle`, {});
          await render();
        } catch (e) { toast(`Не удалось изменить пункт: ${e.message}`, "error"); }
      });
    });
    sheet.querySelectorAll("[data-checklist-del]").forEach(btn => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        try {
          await apiPost(`/report/${publicId}/checklist/${btn.dataset.checklistDel}/delete`, {});
          await render();
        } catch (e) { toast(`Не удалось удалить пункт: ${e.message}`, "error"); }
      });
    });
    sheet.querySelectorAll("[data-unassign]").forEach(btn => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const res = await apiPost(`/report/${publicId}/unassign`, { telegram_id: Number(btn.dataset.unassign) });
          if (res.changed) { toast("Исполнитель снят."); await render(); }
          else btn.disabled = false;
        } catch (e) { toast(`Не удалось снять исполнителя: ${e.message}`, "error"); btn.disabled = false; }
      });
    });
    sheet.querySelector("#btn-delete-report").addEventListener("click", async () => {
      if (!confirm(`Удалить отчёт ${detail.public_id} («${detail.title}»)? Действие необратимо.`)) return;
      const btn = sheet.querySelector("#btn-delete-report");
      btn.disabled = true;
      btn.textContent = "Удаляем…";
      try {
        const res = await apiPost(`/report/${publicId}/delete`, {});
        if (res.deleted) {
          toast("Отчёт удалён.");
          overlay.remove();
          await loadReports();
        } else if (res.pending_approval) {
          toast("Запрос на удаление отправлен владельцу.");
          overlay.remove();
        } else {
          toast("Не удалось удалить.", "error");
          btn.disabled = false;
          btn.textContent = "🗑 Удалить отчёт";
        }
      } catch (e) {
        toast(`Не удалось удалить: ${e.message}`, "error");
        btn.disabled = false;
        btn.textContent = "🗑 Удалить отчёт";
      }
    });
    sheet.querySelector("#btn-history").addEventListener("click", () => openReportLogSheet(publicId, "history"));
    sheet.querySelector("#btn-activity").addEventListener("click", () => openReportLogSheet(publicId, "activity"));

    function renderPipelineDraft() {
      const host = sheet.querySelector("#pipeline-draft-list");
      if (!host) return;
      host.innerHTML = pipelineDraft.length
        ? `<div class="chip-row" style="margin-bottom:8px;">${pipelineDraft.map((s, i) =>
            `<span class="chip">${i + 1}. ${esc(s.role)}${s.name ? ` — ${esc(s.name)}` : ""} <button class="icon-btn" data-remove-step="${i}" style="padding:0 2px; border:none;">✕</button></span>`
          ).join("")}</div>`
        : `<div class="no-assignee">Пока пусто — добавьте первый этап</div>`;
      host.querySelectorAll("[data-remove-step]").forEach(btn => {
        btn.addEventListener("click", () => {
          pipelineDraft.splice(parseInt(btn.dataset.removeStep, 10), 1);
          renderPipelineDraft();
        });
      });
    }
    renderPipelineDraft();

    sheet.querySelector("#pipeline-add-step").addEventListener("click", () => {
      const roleSel = sheet.querySelector("#pipeline-role-pick");
      const userSel = sheet.querySelector("#pipeline-user-pick");
      const role = roleSel.value;
      if (!role) { toast("Выберите роль.", "error"); return; }
      const telegram_id = userSel.value ? Number(userSel.value) : null;
      const name = telegram_id ? userSel.options[userSel.selectedIndex].textContent : null;
      pipelineDraft.push({ role, telegram_id, name });
      roleSel.value = "";
      userSel.value = "";
      renderPipelineDraft();
    });
    sheet.querySelector("#btn-pipeline-save").addEventListener("click", async () => {
      try {
        await apiPost(`/report/${publicId}/pipeline`, { steps: pipelineDraft.map(s => ({ role: s.role, telegram_id: s.telegram_id })) });
        toast(pipelineDraft.length ? "Пайплайн сохранён." : "Пайплайн снят.");
        await render();
      } catch (e) { toast(`Не удалось сохранить пайплайн: ${e.message}`, "error"); }
    });
    const clearBtn = sheet.querySelector("#btn-pipeline-clear");
    if (clearBtn) clearBtn.addEventListener("click", async () => {
      if (!confirm("Снять пайплайн с отчёта?")) return;
      try {
        await apiPost(`/report/${publicId}/pipeline`, { steps: [] });
        toast("Пайплайн снят.");
        await render();
      } catch (e) { toast(`Не удалось снять пайплайн: ${e.message}`, "error"); }
    });
    const advanceBtn = sheet.querySelector("#btn-pipeline-advance");
    if (advanceBtn) advanceBtn.addEventListener("click", async () => {
      const userSel = sheet.querySelector("#pipeline-next-user");
      advanceBtn.disabled = true;
      try {
        const nextUser = userSel && userSel.value ? Number(userSel.value) : null;
        const res = await apiPost(`/report/${publicId}/pipeline/advance`, { telegram_id: nextUser });
        if (res.advanced) { toast(`Передано: ${res.role}.`); await render(); }
        else { toast(res.detail || "Не удалось передать.", "error"); advanceBtn.disabled = false; }
      } catch (e) { toast(`Не удалось передать этап: ${e.message}`, "error"); advanceBtn.disabled = false; }
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
    const notesSortBtn = sheet.querySelector("#notes-sort");
    if (notesSortBtn) notesSortBtn.addEventListener("click", async () => {
      notesByTime = !notesByTime;
      await render();
    });
    sheet.querySelector("#note-add").addEventListener("click", async () => {
      const ta = sheet.querySelector("#note-new");
      const timeInput = sheet.querySelector("#note-time");
      const text = ta.value.trim();
      if (!text) return;
      const seconds = secondsFromTimeInput(timeInput.value);
      if (seconds === null) {
        toast("Время — в формате 04:12 или 1:02:03.", "error");
        timeInput.focus();
        return;
      }
      // Время уходит префиксом в сам текст: отдельного поля под него в
      // API заметок нет, а так его увидят и бот, и мини-апп.
      const payload = timeInput.value.trim() ? noteTimePrefix(seconds) + text : text;
      try {
        await apiPost(`/report/${publicId}/notes`, { text: payload });
        await render();
      } catch (e) { toast(`Не удалось добавить заметку: ${e.message}`, "error"); }
    });
    sheet.querySelector("#btn-qc-track").addEventListener("click", async () => {
      const picked = await openDialog({ multiple: false, filters: [{ name: "Аудио/видео", extensions: QC_EXTENSIONS }] });
      if (!picked) return;
      await runQcAnalysis(Array.isArray(picked) ? picked[0] : picked, { reportId: publicId });
    });
    sheet.querySelectorAll("[data-download-file]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const fileId = btn.dataset.downloadFile;
        const savePath = await saveDialog({ defaultPath: btn.dataset.fileName || undefined });
        if (!savePath) return;
        btn.disabled = true;
        try {
          await invoke("download_report_file", {
            reportId: publicId,
            fileId,
            initData: state.token || "",
            savePath,
          });
          toast("Файл сохранён.");
        } catch (e) {
          toast(`Не удалось скачать: ${e}`, "error");
        } finally {
          btn.disabled = false;
        }
      });
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
    <span style="flex:1;">${esc(item.text)}</span>
    <button class="icon-btn" data-checklist-del="${item.id}" title="Удалить">✕</button>
  </div>`;
}

function noteHtml(n) {
  const t = parseNoteTime(n.text);
  return `<div class="note-item${t ? " timed" : ""}">
    <div class="meta">${esc(n.author)} · ${esc(n.created_at || "")}</div>
    <div class="note-body">
      ${t ? `<span class="note-time" title="время на дорожке">${esc(t.label)}</span>` : ""}
      <span>${esc(t ? t.rest : n.text)}</span>
    </div>
  </div>`;
}

// Текущая цепочка пайплайна (только чтение) + «передать дальше», если
// есть следующий этап — отдельно от черновика-билдера ниже (тот
// пересобирает цепочку целиком, этот просто двигает текущий указатель).
function pipelineChainHtml(pipeline, assignable) {
  if (!pipeline || !pipeline.length) return "";
  const curIdx = pipeline.findIndex(s => s.current);
  const hasNext = curIdx !== -1 && curIdx < pipeline.length - 1;
  const chain = `<div class="chip-row" style="margin-bottom:8px;">${pipeline.map(s =>
    `<span class="chip" style="${s.done ? "opacity:.55;" : (s.current ? "border-color:var(--fire); color:var(--fire);" : "")}">${esc(s.role)}${s.user_name ? ` — ${esc(s.user_name)}` : ""}</span>`
  ).join("")}</div>`;
  const advanceRow = hasNext
    ? `<div class="add-row" style="margin-bottom:8px;">
        <select id="pipeline-next-user" class="field-input">${userOptionsHtml(assignable, null)}</select>
        <button class="btn" id="btn-pipeline-advance">🔥 Передать дальше</button>
      </div>`
    : "";
  return chain + advanceRow;
}

// Скачивание — кнопка, а не <a href>. Ссылка с target="_blank" внутри
// webview вообще ничего не открывает (окно создавать некому), а токен
// в ней уезжал в query-строку — то есть в логи сервера. Теперь файл
// тянет Rust-команда download_report_file (токен заголовком), путь
// выбирает нативный диалог сохранения.
// Тип проверяем и по file_type, и по имени: file_type у файла,
// присланного документом, приходит "document" — и mp3 внутри него
// раньше оставался без кнопки AI-проверки, потому что || до имени
// просто не доходил.
function fileHtml(f) {
  const audioRe = /audio|\.(wav|mp3|flac|m4a|aac|ogg)$/i;
  const isAudio = audioRe.test(f.file_type || "") || audioRe.test(f.file_name || "");
  return `<div class="file-item">
    <div>${esc(FILE_ICONS[f.file_type] || "📎")} ${esc(f.file_name || f.file_type)} <span class="meta">${esc(f.file_size_label || "")}</span></div>
    ${isAudio ? `<button class="btn" style="padding:4px 10px; font-size:12px;" data-qc-file="${f.id}">🤖 AI-проверка</button>` : ""}
    <button class="icon-btn" data-download-file="${f.id}" data-file-name="${esc(f.file_name || "")}" title="Скачать">⬇️</button>
    <div id="qc-result-${f.id}" style="width:100%;"></div>
  </div>`;
}

// История статуса и лента активности отчёта — тот же /history и
// /activity, что и в мини-аппе, листаются кнопкой «Показать ещё»
// (page_size=20, как там же), а не бесконечной прокруткой.
async function openReportLogSheet(publicId, kind) {
  const title = kind === "history" ? "🕓 История" : "📜 Активность";
  const overlay = openSheet(`<h2>${title}</h2>${dialogSkeletonHtml(5)}`);
  const sheet = overlay.querySelector(".sheet");

  let offset = 0;
  const pageSize = 20;
  let events = [];

  function eventLineHtml(ev) {
    if (kind === "history") {
      return `<div class="note-item">
        <div class="meta">${esc(ev.actor)} · ${esc(ev.created_at || "")}</div>
        <div>${esc(ev.new_status_label || "")}${ev.comment ? `: ${esc(ev.comment)}` : ""}</div>
      </div>`;
    }
    return `<div class="note-item">
      <div class="meta">${esc(ev.actor)} · ${esc(ev.created_at || "")}</div>
      <div>${esc(ev.action || "")}${ev.detail ? ` — ${esc(ev.detail)}` : ""}</div>
    </div>`;
  }

  async function loadMore() {
    const res = await apiGet(`/report/${publicId}/${kind}`, { offset, page_size: pageSize });
    events = events.concat(res.events || []);
    offset += (res.events || []).length;
    sheet.innerHTML = `
      <h2>${title}</h2>
      <div id="log-list">${events.map(eventLineHtml).join("") || `<div class="no-assignee">Пока пусто</div>`}</div>
      ${res.has_more ? `<div class="sheet-actions"><button class="btn" id="log-more">Показать ещё</button></div>` : ""}
      <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
    `;
    sheet.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => overlay.remove()));
    const moreBtn = sheet.querySelector("#log-more");
    // try/catch прямо тут: раньше ошибка второй и следующих страниц
    // никем не ловилась (try ниже охватывает только первый вызов) —
    // кнопка навсегда оставалась disabled, а reject уходил в консоль.
    if (moreBtn) moreBtn.addEventListener("click", async () => {
      moreBtn.disabled = true;
      moreBtn.textContent = "Загрузка…";
      try {
        await loadMore();
      } catch (e) {
        toast(`Не удалось загрузить ещё: ${e.message}`, "error");
        moreBtn.disabled = false;
        moreBtn.textContent = "Показать ещё";
      }
    });
  }

  try {
    await loadMore();
  } catch (e) {
    sheet.innerHTML = `<div style="color:var(--s-stop);">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  }
}
