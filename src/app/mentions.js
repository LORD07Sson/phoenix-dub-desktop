// Список на упоминание — то же, что «Доступ → Упоминания» в боте
// (admin/mentions.py): кого поднимать в рабочем чате, пока ему не выдали
// доступ. Бот сам напоминает раз в N дней (тумблер), «Упомянуть сейчас»
// шлёт упоминание в рабочий чат сразу. Кому выдали доступ — выпадает
// из списка сам. /api/mentions, /toggle, /auto, /send.

import { apiGet, apiPost, openSheet, toast, dialogSkeletonHtml } from "./api.js";
import { esc, relTime } from "./utils.js";
import { loadAvatars } from "./profile.js";

const X_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

function timesWord(n) {
  const m10 = n % 10, m100 = n % 100;
  return m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "раза" : "раз";
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}

export async function openMentionsSheet(onChange) {
  const overlay = openSheet(`<h2>Список на упоминание</h2>${dialogSkeletonHtml(5)}`);
  const sheet = overlay.querySelector(".sheet");
  sheet.classList.add("mn-sheet");

  function render(d) {
    sheet.innerHTML = `
      <h2>Список на упоминание</h2>
      <p class="tn-hint">Кого поднимать в рабочем чате, пока ему не выдали доступ в бота. Кому выдали — выпадает из списка сам.</p>
      <div class="mn-auto">
        <label class="mn-switch"><input type="checkbox" id="mn-auto"${d.auto_enabled ? " checked" : ""}><span></span></label>
        <div class="mn-auto-text">
          <b>Напоминать самому раз в ${d.interval_days} ${d.interval_days === 1 ? "день" : (d.interval_days < 5 ? "дня" : "дней")}</b>
          <span>${d.auto_enabled
            ? (d.next_send ? `следующее — ${esc(fmtDate(d.next_send))}` : "первое — при ближайшей проверке")
            : "выключено"}${d.last_sent ? ` · последнее было ${esc(fmtDate(d.last_sent))}` : ""}</span>
        </div>
        <button type="button" class="btn primary" id="mn-send"${d.watchlist.length ? "" : " disabled"}>Упомянуть сейчас · ${d.watchlist.length}</button>
      </div>
      <div class="mn-add">
        <select id="mn-cand" aria-label="Добавить из тех, кто писал боту">
          <option value="">${d.candidates.length ? "+ из тех, кто писал боту…" : "все, кто писал боту, уже в списке или с доступом"}</option>
          ${d.candidates.map(c => `<option value="${c.telegram_id}">${esc(c.name)}${c.username ? ` (@${esc(c.username)})` : ""}</option>`).join("")}
        </select>
        <input type="number" id="mn-id" placeholder="или Telegram ID числом" aria-label="Telegram ID">
        <button type="button" class="btn" id="mn-add-id">Добавить</button>
      </div>
      <div class="mn-list">
        ${d.watchlist.length ? d.watchlist.map(w => `
          <div class="mn-row">
            <span class="avatar-bubble mn-av" data-avatar-for="${w.telegram_id}">${esc(String(w.name).replace(/^@/, "").charAt(0).toUpperCase())}</span>
            <span class="mn-name"><b>${esc(w.name)}</b><span>${w.username ? `@${esc(w.username)} · ` : ""}ID ${w.telegram_id}</span></span>
            <span class="mn-count${w.count >= 3 ? " many" : ""}">${w.count ? `упомянут ${w.count} ${timesWord(w.count)}` : "ещё не упоминали"}${w.last_mentioned_at ? ` · ${esc(relTime(w.last_mentioned_at))}` : ""}</span>
            <button type="button" class="icon-btn bd-del" data-mn-del="${w.telegram_id}" title="Убрать из списка" aria-label="Убрать ${esc(w.name)}">${X_ICON}</button>
          </div>`).join("") : `<div class="no-assignee">Список пуст</div>`}
      </div>
      <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    loadAvatars(sheet);
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    const call = async (path, body, ok) => {
      try {
        const r = await apiPost(path, body);
        render(r);
        if (ok) toast(ok);
        if (onChange) onChange(r);
      } catch (e) { toast(e.message, "error"); render(d); }
    };
    sheet.querySelector("#mn-auto").addEventListener("change", e => call("/mentions/auto", { enabled: e.target.checked }, e.target.checked ? "Автонапоминание включено." : "Автонапоминание выключено."));
    sheet.querySelector("#mn-cand").addEventListener("change", e => { if (e.target.value) call("/mentions/toggle", { telegram_id: Number(e.target.value) }); });
    sheet.querySelector("#mn-add-id").addEventListener("click", () => {
      const id = parseInt(sheet.querySelector("#mn-id").value, 10);
      if (!id) { toast("Введите Telegram ID числом.", "error"); return; }
      call("/mentions/toggle", { telegram_id: id, add_by_id: true }, "Добавлено.");
    });
    sheet.querySelectorAll("[data-mn-del]").forEach(b => b.addEventListener("click", () => call("/mentions/toggle", { telegram_id: Number(b.dataset.mnDel) })));
    sheet.querySelector("#mn-send").addEventListener("click", async e => {
      if (!confirm(`Упомянуть ${d.watchlist.length} чел. в рабочем чате прямо сейчас?`)) return;
      e.currentTarget.disabled = true;
      await call("/mentions/send", {}, "Упоминание отправлено в рабочий чат.");
    });
  }

  try {
    render(await apiGet("/mentions"));
  } catch (e) {
    sheet.innerHTML = `<h2>Список на упоминание</h2><div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  }
}
