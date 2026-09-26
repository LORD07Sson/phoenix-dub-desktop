// Развёрнутая карточка отчёта (шторка): чек-лист, заметки, файлы,
// серверная AI-проверка звука. Открывается из Списка/Доски/Ленты/
// профиля коллеги.

import { apiGet, apiPost, openSheet, toast, dialogSkeletonHtml } from "./api.js";
import { state } from "./state.js";
import { invoke, pickOutputFile, pickInputFile, revealInFolder, pinReportWindow } from "./tauri.js";
import { esc, initials, STATUS_DOT_CLASS, STATUS_COLOR_VAR, isOverdue, parseNoteTime, secondsFromTimeInput, noteTimePrefix, formatRange } from "./utils.js";
import { runQcAnalysis, QC_EXTENSIONS } from "./qc.js";
import { changeStatusDialog, assignDialog, priorityDialog, deadlineDialog, loadReports, listNeighbors, seriesParts, priorityFlagHtml, deadlineCellHtml, posterSrc } from "./reports.js";
import { loadSidebarStatusCounts } from "./tabs.js";
import { loadRoles, loadAssignable, userOptionsHtml } from "./titles-admin.js";
import { setDropTarget } from "./file-drop.js";
import { recordRecentReport } from "./recent-reports.js";
import { toggleFocusMode, syncFocusButton } from "./focus-mode.js";
import { loadAvatars } from "./profile.js";
import { createPlayer, isAudioFile } from "./player.js";

// Ключи "kind" — ровно те, что отдаёт серверный audio_qc.py (miniapp/audio_qc.py):
// "clip"/"noise"/"silence"/"silence_long"/"no_speech". Раньше здесь жил набор
// clipping/silence/noise/loud/quiet — ни один ключ не совпадал с реальным
// ответом сервера, находки просто не подписывались.
const QC_FINDING_LABELS_RU = { clip: "Клиппинг", noise: "Шум", silence_long: "Долгая тишина", no_speech: "Речь не найдена" };
const FILE_ICONS = { photo: "🖼", video: "🎬", audio: "🎵", voice: "🎙", document: "📄" };

export async function openReportDetail(publicId) {
  const overlay = openSheet(`
    <h2 class="skeleton-row" style="width:60%; height:22px;"></h2>
    ${dialogSkeletonHtml(5)}
  `, "wide");
  // Класс-маркер, а не просто ".sheet-wide" (её же используют admin.js,
  // profile.js, titles-admin.js) — фокус-режим (focus-mode.js) должен
  // отличать именно карточку отчёта от остальных широких модалок, чтобы
  // не прятать шапку/сайдбар под какой-нибудь другой из них.
  overlay.classList.add("report-detail-overlay");
  // Фокус-режим слушает эти два события, а не сам следит за DOM —
  // открытие/закрытие карточки уже единственное место, где меняется
  // presence ".report-detail-overlay".
  document.dispatchEvent(new CustomEvent("report-detail-opened", { detail: { publicId } }));

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
  // Плеер дорожки переживает перерисовки карточки (см. player.js).
  let player = null;

  // Переход к соседнему отчёту выборки «Списка», не закрывая карточку
  // (как стрелки в шторке мини-аппа). Соседи считаются заново на каждый
  // переход — список могли пересортировать или отфильтровать.
  const goTo = targetId => {
    if (!targetId) return;
    overlay.remove();
    openReportDetail(targetId);
  };
  const onNavKey = e => {
    if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    const overlays = document.querySelectorAll(".overlay");
    if (overlays[overlays.length - 1] !== overlay) return;
    const nb = listNeighbors(publicId);
    if (!nb) return;
    e.preventDefault();
    goTo(e.key === "ArrowLeft" ? nb.prev : nb.next);
  };
  document.addEventListener("keydown", onNavKey, true);
  let recentRecorded = false; // пишем в MRU один раз за открытие, не на каждый render()
  new MutationObserver((_muts, obs) => {
    if (!overlay.isConnected) {
      obs.disconnect();
      if (player) { player.destroy(); player = null; }
      setDropTarget(null);
      document.removeEventListener("report-file-uploaded", onFileUploaded);
      document.removeEventListener("report-notes-added", onFileUploaded);
      document.removeEventListener("keydown", onNavKey, true);
      document.dispatchEvent(new CustomEvent("report-detail-closed", { detail: { publicId } }));
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
    if (!recentRecorded) {
      recentRecorded = true;
      recordRecentReport(publicId, detail.title);
    }

    // Черновик цепочки пайплайна — правится локально до нажатия
    // «Сохранить», как и в мини-аппе (pipelineDraft): полный список
    // шагов уходит на /pipeline разом, PATCH одного шага сервер не
    // умеет. Сбрасывается при каждом render() (в т.ч. после сохранения
    // заметки/чек-листа отчёта) — то же поведение, что и там.
    let pipelineDraft = (detail.pipeline || []).map(s => ({ role: s.role, telegram_id: s.telegram_id || null, name: s.user_name || null }));

    const dotClass = STATUS_DOT_CLASS[detail.status] || "draft";
    const overdue = isOverdue(detail);
    const nav = listNeighbors(publicId);

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

    const t = seriesParts(detail);
    const poster = posterSrc(detail.poster_url);
    const authorName = (detail.author && (detail.author.first_name || detail.author.username)) || "?";
    const hasPipe = detail.pipeline && detail.pipeline.length;
    const doneItems = checklist.items.filter(i => i.done).length;
    const steps = STATUS_PATH.map(([st, lbl], i) => {
      const curIdx = STATUS_PATH.findIndex(([s]) => s === detail.status);
      const cls = st === detail.status ? " cur" : curIdx > i ? " done" : "";
      return `<button class="rd-step${cls}" data-set-status="${st}" style="--c:var(${STATUS_COLOR_VAR[st]});"><i></i>${lbl}</button>`;
    }).join("");
    const side = detail.status === "revision" || detail.status === "cancelled" ? detail.status : "";

    overlay.querySelector(".sheet").innerHTML = `
      <div class="rd-hero">
        <div class="rd-hero-bg"${poster ? ` style="background-image:url('${esc(poster)}')"` : ""}></div>
        <div class="rd-hero-in">
          <span class="rd-poster"${poster ? ` style="background-image:url('${esc(poster)}')"` : ""}>${poster ? "" : esc(initials(t.name))}</span>
          <div class="rd-titles">
            <h2>${esc(t.name)}${t.ep ? `<span class="ls-ep">${esc(t.ep)}</span>` : ""}${priorityFlagHtml(detail.priority)}</h2>
            <div class="rd-sub">${esc(detail.public_id)}${t.sub ? ` · ${esc(t.sub)}` : ""} · создал ${esc(authorName)} · ${esc(String(detail.created_at || "").slice(0, 16))}</div>
          </div>
          <div class="detail-head-actions">
            ${nav ? `
              <button class="icon-btn" data-nav="prev" title="Предыдущий в списке (Alt+←)" aria-label="Предыдущий отчёт" ${nav.prev ? "" : "disabled"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
              <button class="icon-btn" data-nav="next" title="Следующий в списке (Alt+→)" aria-label="Следующий отчёт" ${nav.next ? "" : "disabled"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>` : ""}
            <button class="icon-btn" id="btn-focus-toggle" data-focus-toggle style="flex:none;"></button>
            <button class="icon-btn" data-close style="flex:none;" title="Закрыть" aria-label="Закрыть"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
          </div>
        </div>
        <div class="rd-steps">
          ${steps}
          <button class="rd-step-side${side === "revision" ? " on" : ""}" data-set-status="revision" style="--c:var(--s-fix);">↺ На перезапись</button>
          ${side === "cancelled" ? `<span class="rd-step-side on" style="--c:var(--s-stop);">Отменено</span>` : ""}
        </div>
      </div>

      <div class="rd-tabs">
        <button class="rd-tab on" data-rd-tab="main">Обзор</button>
        <button class="rd-tab" data-rd-tab="history">История</button>
        <button class="rd-tab" data-rd-tab="activity">Активность</button>
        <button class="rd-tab" id="btn-qc-track" title="Проверить звук дорожки">QC дорожки</button>
      </div>

      <div class="rd-body">
        <div class="rd-main">
          <div class="rd-panel" data-rd-panel="main">
            <div id="rd-player-host"></div>
            <div class="rd-sec">
              <h3>Пайплайн ${hasPipe ? `<span class="n">${detail.pipeline.filter(s => s.done).length} из ${detail.pipeline.length}</span>` : ""}
                <button class="pf-link rd-h-act" id="pipe-edit-toggle">${hasPipe ? "изменить" : ""}</button></h3>
              ${hasPipe ? pipelineTimelineHtml(detail.pipeline) + pipelineAdvanceHtml(detail.pipeline, assignable) : `<button class="rd-add" id="pipe-add-open">+ Собрать пайплайн: перевод → тайминг → озвучка…</button>`}
              <div id="pipe-editor" hidden>
                <div id="pipeline-draft-list"></div>
                <div class="add-row">
                  <select id="pipeline-role-pick" class="field-input"><option value="">+ роль…</option>${roles.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join("")}</select>
                  <select id="pipeline-user-pick" class="field-input">${userOptionsHtml(assignable, null)}</select>
                  <button class="btn" id="pipeline-add-step">+</button>
                </div>
                <div class="sheet-actions" style="margin-top:8px;">
                  <button class="btn primary" id="btn-pipeline-save">Сохранить пайплайн</button>
                  ${hasPipe ? `<button class="btn danger" id="btn-pipeline-clear">Снять</button>` : ""}
                </div>
              </div>
            </div>

            <div class="rd-sec">
              <h3>Чек-лист ${checklist.items.length ? `<span class="n">${doneItems} из ${checklist.items.length}</span>` : ""}</h3>
              <div id="checklist-list">${checklist.items.map(checklistItemHtml).join("")}</div>
              <div class="add-row">
                <input id="checklist-new" placeholder="${checklist.items.length ? "Ещё пункт…" : "+ Добавить пункт: например, «сверить имена»"}">
                <button class="btn" id="checklist-add">+</button>
              </div>
            </div>

            <div class="rd-sec">
              <h3>Заметки ${notes.notes.length ? `<span class="n">${notes.notes.length}</span>` : ""}
                ${timedCount >= 2 ? `<button class="btn ghost notes-sort rd-h-act" id="notes-sort">${notesByTime ? "По времени добавления" : "По тайм-коду"}</button>` : ""}
              </h3>
              <div id="notes-list">${orderedNotes.map(noteHtml).join("")}</div>
              <div class="add-row note-add-row">
                <input id="note-time" class="note-time-input" placeholder="04:12" maxlength="8" inputmode="numeric" title="Время на дорожке — необязательно">
                <textarea id="note-new" rows="2" placeholder="Правка или комментарий… (Ctrl+Enter — отправить)"></textarea>
                <button class="btn" id="note-add">Добавить</button>
              </div>
            </div>

            ${files.files.length ? `
            <div class="rd-sec">
              <h3>Файлы <span class="n">${files.files.length}</span></h3>
              <div id="files-list">${files.files.map(fileHtml).join("")}</div>
            </div>` : ""}
          </div>
          <div class="rd-panel" data-rd-panel="history" hidden></div>
          <div class="rd-panel" data-rd-panel="activity" hidden></div>
        </div>

        <aside class="rd-side">
          <div class="rd-meta">
            <div class="rd-meta-row"><span>Исполнители / кого уведомить</span>
              ${(detail.assignees || []).map(a => `<div class="rd-person" data-assignee="${a.telegram_id}">
                <span class="avatar-bubble" data-avatar-for="${a.telegram_id}">${esc(initials(a.first_name || a.username))}</span>
                <span>${esc(a.first_name || a.username || `ID ${a.telegram_id}`)}</span>
                <button class="icon-btn" data-unassign="${a.telegram_id}" title="Снять">✕</button>
              </div>`).join("")}
              <button class="rd-add" id="chip-assign">+ ${detail.assignees && detail.assignees.length ? "ещё исполнитель" : "назначить"}</button>
            </div>
            <div class="rd-meta-row"><span>Срок</span>
              <button class="rd-meta-btn" id="chip-deadline">${detail.deadline ? deadlineCellHtml(detail, overdue) : `<span class="ls-dl-none">без срока — поставить</span>`}</button></div>
            <div class="rd-meta-row"><span>Приоритет</span>
              <button class="rd-meta-btn" id="chip-priority"><span class="priority-chip ${esc(detail.priority)}"><span class="dot"></span>${esc(detail.priority_label)}</span></button></div>
            <div class="rd-meta-row"><span>Статус</span>
              <button class="rd-meta-btn" id="chip-status"><span class="chip status-chip" style="--chip-accent: var(${STATUS_COLOR_VAR[detail.status] || "--s-draft"})"><span class="dot ${dotClass}"></span>${esc(detail.status_label)}</span></button></div>
          </div>
          <div class="rd-side-foot">
            <button class="btn ghost" id="btn-pin-window">Открепить в окне</button>
            <button class="btn danger" id="btn-delete-report">Удалить отчёт</button>
          </div>
        </aside>
      </div>
    `;

    const sheet = overlay.querySelector(".sheet");
    sheet.querySelectorAll("[data-set-status]").forEach(b => b.addEventListener("click", async () => {
      const status = b.dataset.setStatus;
      if (status === detail.status) return;
      try {
        await apiPost(`/report/${publicId}/status`, { status, comment: "" });
        toast("Статус обновлён.", "success");
        loadReports();
        loadSidebarStatusCounts();
        await render();
      } catch (e) { toast(`Не удалось сменить статус: ${e.message}`, "error"); }
    }));
    sheet.querySelectorAll("[data-rd-tab]").forEach(b => b.addEventListener("click", () => {
      const tab = b.dataset.rdTab;
      sheet.querySelectorAll("[data-rd-tab]").forEach(x => x.classList.toggle("on", x === b));
      sheet.querySelectorAll("[data-rd-panel]").forEach(p => { p.hidden = p.dataset.rdPanel !== tab; });
      if (tab !== "main") fillLogPanel(sheet.querySelector(`[data-rd-panel="${tab}"]`), publicId, tab);
    }));
    const pipeEditor = sheet.querySelector("#pipe-editor");
    const openPipeEditor = () => { pipeEditor.hidden = !pipeEditor.hidden; };
    sheet.querySelector("#pipe-add-open")?.addEventListener("click", e => { e.currentTarget.remove(); pipeEditor.hidden = false; });
    const pipeToggle = sheet.querySelector("#pipe-edit-toggle");
    if (hasPipe) pipeToggle.addEventListener("click", openPipeEditor); else pipeToggle.remove();
    sheet.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => overlay.remove()));
    loadAvatars(sheet);
    sheet.querySelectorAll("[data-nav]").forEach(b => b.addEventListener("click", () => {
      const nb = listNeighbors(publicId);
      if (nb) goTo(b.dataset.nav === "prev" ? nb.prev : nb.next);
    }));
    syncFocusButton(sheet.querySelector("#btn-focus-toggle"));
    sheet.querySelector("#btn-focus-toggle").addEventListener("click", toggleFocusMode);
    sheet.querySelector("#btn-pin-window").addEventListener("click", async () => {
      try {
        await pinReportWindow(publicId);
      } catch (e) {
        toast(`Не удалось открыть окно: ${e}`, "error");
      }
    });
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
          loadSidebarStatusCounts();
        } else if (res.pending_approval) {
          toast("Запрос на удаление отправлен владельцу.");
          overlay.remove();
        } else {
          toast("Не удалось удалить.", "error");
          btn.disabled = false;
          btn.textContent = "Удалить отчёт";
        }
      } catch (e) {
        toast(`Не удалось удалить: ${e.message}`, "error");
        btn.disabled = false;
        btn.textContent = "Удалить отчёт";
      }
    });

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
    async function addNote() {
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
    }
    sheet.querySelector("#note-add").addEventListener("click", addNote);
    // Ctrl/Cmd+Enter из самого поля — привычка из Slack/GitHub/Linear:
    // руки уже на клавиатуре после текста заметки, тянуться к кнопке
    // мышью незачем. Обычный Enter не годится — заметки часто
    // многострочные (тайм-коды правок один за другим).
    sheet.querySelector("#note-new").addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        addNote();
      }
    });
    sheet.querySelector("#btn-qc-track").addEventListener("click", async () => {
      const picked = await pickInputFile([{ name: "Аудио/видео", extensions: QC_EXTENSIONS }]);
      if (!picked) return;
      await runQcAnalysis(picked, { reportId: publicId });
    });
    sheet.querySelectorAll("[data-download-file]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const fileId = btn.dataset.downloadFile;
        const savePath = await pickOutputFile(btn.dataset.fileName);
        if (!savePath) return;
        btn.disabled = true;
        try {
          await invoke("download_report_file", {
            reportId: publicId,
            fileId,
            initData: state.token || "",
            savePath,
          });
          toast("Файл сохранён.", "success", {
            label: "📂 Показать в папке",
            onClick: () => revealInFolder(savePath),
          });
        } catch (e) {
          toast(`Не удалось скачать: ${e}`, "error");
        } finally {
          btn.disabled = false;
        }
      });
    });
    // Плеер: создаётся по первому «▶ Слушать» и дальше просто
    // переставляется в новую разметку после каждой перерисовки.
    const audioFiles = files.files.filter(isAudioFile);
    const playerHost = sheet.querySelector("#rd-player-host");
    if (player && playerHost) {
      playerHost.appendChild(player.el);
      player.setFiles(audioFiles);
      player.setNotes(notes.notes);
      player.refresh();
    }
    sheet.querySelectorAll("[data-play-file]").forEach(btn => {
      btn.addEventListener("click", () => {
        if (!player) {
          player = createPlayer({
            publicId,
            onAddNote: async (seconds, text) => {
              await apiPost(`/report/${publicId}/notes`, { text: noteTimePrefix(seconds) + text });
              await render();
            },
            onClose: () => { player = null; },
          });
        }
        playerHost.appendChild(player.el);
        player.setFiles(audioFiles);
        player.setNotes(notes.notes);
        player.open(Number(btn.dataset.playFile));
        player.el.scrollIntoView({ behavior: "smooth", block: "start" });
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
          // Сервер отдаёт {file_label, result: {issues, duration, error}}
          // (см. miniapp/server.py::api_qc_file) — не {findings}.
          const result = res.result || {};
          const issues = result.issues || [];
          resultEl.innerHTML = issues.length
            ? issues.map(i => `<div class="qc-finding warn"><span class="tag">${esc(QC_FINDING_LABELS_RU[i.kind] || i.kind || "?")}</span><div><div class="time">${formatRange(i.start, i.end)}</div><div>${esc(i.detail || "")}</div></div></div>`).join("")
            : `<div style="color:var(--s-done); font-size:12px;">✓ Замечаний не найдено</div>`;
          if (result.error) {
            resultEl.innerHTML += `<div style="color:var(--s-stop); font-size:12px; margin-top:6px;">${esc(result.error)}</div>`;
          }
        } catch (e) {
          toast(`AI-проверка не удалась: ${e.message}`, "error");
        } finally {
          btn.disabled = false;
          btn.textContent = "AI-проверка";
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
function pipelineAdvanceHtml(pipeline, assignable) {
  if (!pipeline || !pipeline.length) return "";
  const curIdx = pipeline.findIndex(s => s.current);
  const hasNext = curIdx !== -1 && curIdx < pipeline.length - 1;
  const advanceRow = hasNext
    ? `<div class="add-row" style="margin-bottom:8px;">
        <select id="pipeline-next-user" class="field-input">${userOptionsHtml(assignable, null)}</select>
        <button class="btn" id="btn-pipeline-advance">Передать дальше</button>
      </div>`
    : "";
  return advanceRow;
}

// Основной путь статусов («ветки» отчёта) для шапки карточки;
// «перезапись/дозапись» и «отменено» — боковые, рисуются отдельно.
const STATUS_PATH = [["draft", "Черновик"], ["review", "Озвучка"], ["working", "В работе"], ["completed", "Готово"]];

// Пайплайн таймлайном: кто на каком этапе, пройденное отмечено.
function pipelineTimelineHtml(pipeline) {
  return `<div class="rd-timeline">${pipeline.map((s, i) => `
    <div class="rd-tl${s.done ? " done" : ""}${s.current ? " cur" : ""}">
      <span class="rd-tl-dot">${s.done ? "✓" : i + 1}</span>
      <div><div class="rd-tl-t">${esc(s.role)}</div><div class="rd-tl-p">${s.user_name ? esc(s.user_name) : "исполнитель не выбран"}</div></div>
    </div>`).join("")}</div>`;
}

// История и активность — прямо во вкладке карточки: первые 20 событий,
// дальше — прежняя отдельная шторка с «Показать ещё».
async function fillLogPanel(panel, publicId, kind) {
  if (panel.dataset.loaded) return;
  panel.dataset.loaded = "1";
  panel.innerHTML = dialogSkeletonHtml(4);
  let res;
  try {
    res = await apiGet(`/report/${publicId}/${kind}`, { offset: 0, page_size: 20 });
  } catch (e) {
    panel.innerHTML = `<div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div>`;
    delete panel.dataset.loaded;
    return;
  }
  const evs = res.events || [];
  panel.innerHTML = `<div class="pf-acts">${evs.map(ev => `
    <div class="pf-act"><i></i><div>
      <div class="a">${kind === "history" ? esc(ev.new_status_label || "") + (ev.comment ? ` <span>· ${esc(ev.comment)}</span>` : "") : esc(ev.action || "") + (ev.detail ? ` <span>· ${esc(ev.detail)}</span>` : "")}</div>
      <div class="m">${esc(ev.actor || "")} · ${esc(String(ev.created_at || "").slice(0, 16))}</div>
    </div></div>`).join("") || `<div class="pf-quiet">Пока пусто</div>`}</div>
    ${res.has_more ? `<button class="pf-link" data-log-more style="margin-top:10px;">показать всё →</button>` : ""}`;
  panel.querySelector("[data-log-more]")?.addEventListener("click", () => openReportLogSheet(publicId, kind));
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
    ${isAudio ? `<button class="btn primary" style="padding:4px 10px; font-size:12px;" data-play-file="${f.id}">▶ Слушать</button>` : ""}
    ${isAudio ? `<button class="btn" style="padding:4px 10px; font-size:12px;" data-qc-file="${f.id}">AI-проверка</button>` : ""}
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
