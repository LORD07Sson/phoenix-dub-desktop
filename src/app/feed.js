// Вкладка «Лента» (история изменений по отчётам + админ-лог).
// Тот же /api/feed, что у мини-аппа — объединяет report_activity и
// (только для владельцев студии) admin_log, листается "Показать ещё".

import { apiGet, toast, dialogSkeletonHtml } from "./api.js";
import { $, esc, relTime } from "./utils.js";
import { openReportDetail } from "./report-detail.js";
import { markFeedSeen } from "./feed-badge.js";

function feedMeta(ev) {
  if (ev.kind === "admin") return { ic: "🛡️", c: "var(--sakura)" };
  const a = ev.action || "";
  if (a.includes("создан")) return { ic: "🆕", c: "var(--s-done)" };
  if (a.includes("просрочк")) return { ic: "⚠️", c: "var(--s-stop)" };
  if (a.includes("Статус")) return { ic: "🔄", c: "var(--fire)" };
  if (a.includes("снят")) return { ic: "➖", c: "var(--ink-dim)" };
  if (a.includes("назначен")) return { ic: "👤", c: "var(--s-review)" };
  if (a.includes("Заметка")) return { ic: "📝", c: "var(--gold)" };
  if (a.includes("Файл")) return { ic: "📎", c: "var(--s-review)" };
  if (a.includes("Пайплайн")) return { ic: "⏭", c: "var(--ember)" };
  if (a.includes("дедлайн") || a.includes("Срок")) return { ic: "⏰", c: "var(--s-fix)" };
  if (a.includes("изменён")) return { ic: "✏️", c: "var(--ink-soft)" };
  return { ic: "•", c: "var(--ink-dim)" };
}

function feedItemHtml(ev) {
  const meta = feedMeta(ev);
  let actionText = esc(ev.action);
  if (ev.public_id) actionText += ` <span style="color:var(--fire); font-weight:700;">${esc(ev.public_id)}</span>`;
  const detailText = ev.detail ? `<div class="feed-detail">${esc(ev.detail)}</div>` : "";
  const titleText = ev.title ? `<div class="feed-detail" style="color:var(--ink-dim)">${esc(ev.title)}</div>` : "";
  const linkable = !!ev.public_id;
  return `
    <div class="feed-item">
      <div class="feed-dot" style="--fc:${meta.c}">${meta.ic}</div>
      <div class="feed-body${linkable ? " linkable" : ""}"${linkable ? ` data-open="${esc(ev.public_id)}"` : ""}>
        <div class="feed-action">${actionText}</div>
        ${titleText}${detailText}
        <div class="feed-meta">
          ${ev.kind === "admin" ? `<span style="color:var(--sakura); font-weight:700;">владелец</span><span class="sep">·</span>` : ""}
          <span>${esc(ev.actor)}</span><span class="sep">·</span><span>${relTime(ev.created_at)}</span>
        </div>
      </div>
    </div>`;
}

// :not([data-wired]) — «Показать ещё» дописывает события в тот же
// список и снова зовёт wireFeedList на весь контейнер: без фильтра
// старым элементам доставался второй обработчик, и клик по ним
// открывал две шторки отчёта одна поверх другой.
function wireFeedList(root) {
  root.querySelectorAll(".feed-body[data-open]:not([data-wired])").forEach(el => {
    el.dataset.wired = "1";
    el.addEventListener("click", () => openReportDetail(el.dataset.open));
  });
}

const FEED_PAGE_SIZE = 60;
const FEED_HEADER_HTML = `
  <div class="page-header">
    <div>
      <h1>Лента</h1>
      <div class="sub">История изменений по отчётам студии.</div>
    </div>
  </div>`;

export async function loadFeed() {
  const root = $("#feed-body");
  root.innerHTML = dialogSkeletonHtml(6);
  let d;
  try {
    d = await apiGet("/feed", { offset: 0, page_size: FEED_PAGE_SIZE });
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить ленту: ${esc(e.message)}</div>`;
    return false;
  }
  d.events = d.events || [];
  markFeedSeen(d.events[0]?.created_at);
  if (!d.events.length) {
    root.innerHTML = FEED_HEADER_HTML + `<div class="empty-state"><div style="font-size:34px; margin-bottom:8px;">🕓</div>Пока тихо<div class="sub" style="margin-top:4px;">как только кто-то что-то сделает с отчётом — появится здесь</div></div>`;
    return;
  }
  root.innerHTML = FEED_HEADER_HTML + `
    <div class="feed-list" id="feed-list" data-count="${d.events.length}">${d.events.map(feedItemHtml).join("")}</div>
    ${d.has_more ? `<button class="btn feed-load-more" id="feed-loadmore">Показать ещё (${d.total - d.events.length})</button>` : ""}
  `;
  wireFeedList(root);
  const loadMoreBtn = $("#feed-loadmore");
  if (loadMoreBtn) loadMoreBtn.addEventListener("click", async () => {
    const list = $("#feed-list");
    const offset = parseInt(list.dataset.count, 10) || 0;
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = "Загрузка…";
    try {
      const res = await apiGet("/feed", { offset, page_size: FEED_PAGE_SIZE });
      const fresh = res.events || [];
      list.insertAdjacentHTML("beforeend", fresh.map(feedItemHtml).join(""));
      list.dataset.count = offset + fresh.length;
      wireFeedList(root);
      if (res.has_more) {
        loadMoreBtn.disabled = false;
        loadMoreBtn.textContent = `Показать ещё (${res.total - offset - fresh.length})`;
      } else {
        loadMoreBtn.remove();
      }
    } catch (e) {
      toast(`Не удалось загрузить ленту: ${e.message}`, "error");
      loadMoreBtn.disabled = false;
    }
  });
}
