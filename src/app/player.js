// Плеер дорожки в карточке отчёта: волна приложенного звука, метки
// заметок с тайм-кодами прямо на ней, находки QC, переключение версий
// с сохранением позиции и «правка в текущий момент».
//
// Волну считает сервер (/files/{id}/peaks — 1600 пиков через ffmpeg,
// с кэшем), сам звук качается целиком в blob: так <audio> честно
// перематывается куда угодно, а токен уходит заголовком.
// Плеер живёт дольше одной перерисовки карточки: render() в
// report-detail.js пересобирает разметку, а этот элемент просто
// переставляется в новое место — звук при этом не прерывается.

import { apiGet, apiPost, apiBlob, toast } from "./api.js";
import { esc, parseNoteTime, formatRange } from "./utils.js";

const AUDIO_RE = /audio|\.(wav|mp3|flac|m4a|aac|ogg|oga|opus)$/i;
const MIME = { wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg" };
const QC_LABEL = { clip: "клиппинг", noise: "шум", silence: "тишина", silence_long: "долгая тишина", no_speech: "нет речи" };

export function isAudioFile(f) {
  return AUDIO_RE.test(f.file_type || "") || AUDIO_RE.test(f.file_name || "");
}

function fmt(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + ":" + String(sec).padStart(2, "0");
}

export function createPlayer({ publicId, onAddNote, onClose }) {
  const el = document.createElement("section");
  el.className = "tp";
  el.tabIndex = -1;
  el.innerHTML = `
    <div class="tp-top">
      <b class="tp-h">Дорожка</b>
      <div class="tp-files" data-tp-files></div>
      <label class="tp-sw"><input type="checkbox" data-tp-qcshow checked> находки QC</label>
      <button type="button" class="btn ghost tp-qc" data-tp-qc>Найти проблемы</button>
      <button type="button" class="icon-btn" data-tp-close title="Закрыть плеер" aria-label="Закрыть плеер"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="tp-wave" data-tp-wave tabindex="0" aria-label="Волна дорожки: клик — перейти к моменту">
      <canvas></canvas>
      <div class="tp-hover" hidden><span></span></div>
      <div class="tp-head"></div>
      <div class="tp-msg" data-tp-msg>Готовлю волну…</div>
    </div>
    <div class="tp-ruler" data-tp-ruler></div>
    <div class="tp-ctl">
      <button type="button" class="tp-play" data-tp-play aria-label="Играть" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg></button>
      <span class="tp-time"><b data-tp-cur>0:00</b> <span>/ <i data-tp-dur>0:00</i></span></span>
      <button type="button" class="btn ghost" data-tp-seek="-5">−5 с</button>
      <button type="button" class="btn ghost" data-tp-seek="5">+5 с</button>
      <button type="button" class="btn ghost" data-tp-note="-1">◀ правка</button>
      <button type="button" class="btn ghost" data-tp-note="1">правка ▶</button>
      <span class="tp-keys"><kbd>Пробел</kbd> плей · <kbd>←</kbd><kbd>→</kbd> 5 с · <kbd>N</kbd> правка здесь</span>
    </div>
    <div class="tp-add">
      <span class="tp-at" data-tp-at>0:00</span>
      <input data-tp-input placeholder="Правка в текущий момент… Enter — добавить в заметки" maxlength="900">
    </div>
  `;
  const $ = sel => el.querySelector(sel);
  const wave = $("[data-tp-wave]"), canvas = wave.querySelector("canvas"), head = wave.querySelector(".tp-head");
  const hover = wave.querySelector(".tp-hover"), msg = $("[data-tp-msg]"), playBtn = $("[data-tp-play]");
  const input = $("[data-tp-input]");
  const audio = new Audio();
  audio.preload = "auto";

  let files = [], file = null, peaks = [], duration = 0, notes = [], qc = [], blobUrl = "", raf = 0, loadSeq = 0, qcShown = true;

  function dur() { return audio.duration && isFinite(audio.duration) ? audio.duration : duration; }
  function cur() { return audio.currentTime || 0; }

  function draw() {
    const r = wave.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, r.width, r.height);
    const cs = getComputedStyle(el);
    const done = cs.getPropertyValue("--tp-done").trim() || "#ff7a3d";
    const done2 = cs.getPropertyValue("--tp-done2").trim() || "#f5b94a";
    const rest = cs.getPropertyValue("--tp-rest").trim() || "rgba(128,128,128,.35)";
    const mid = r.height / 2, bars = Math.floor(r.width / 3), pos = dur() ? cur() / dur() * r.width : 0;
    for (let i = 0; i < bars; i++) {
      const p = peaks.length ? peaks[Math.floor(i / bars * peaks.length)] : 0.04;
      const a = Math.max(1, p * (mid - 6));
      const x = i * 3;
      if (x < pos) {
        const g = c.createLinearGradient(0, mid - a, 0, mid + a);
        g.addColorStop(0, done2); g.addColorStop(1, done);
        c.fillStyle = g;
      } else c.fillStyle = rest;
      c.fillRect(x, mid - a, 2, a * 2);
    }
  }

  function layout() {
    const d = dur(), w = wave.clientWidth;
    head.style.left = (d ? cur() / d * w : 0) + "px";
    $("[data-tp-cur]").textContent = fmt(cur());
    $("[data-tp-at]").textContent = fmt(cur());
    $("[data-tp-dur]").textContent = fmt(d);
    wave.querySelectorAll(".tp-mk, .tp-qcz").forEach(e => e.remove());
    if (!d) return;
    if (qcShown) qc.forEach(q => {
      const z = document.createElement("div");
      z.className = "tp-qcz";
      z.style.left = (q.start / d * 100) + "%";
      z.style.width = Math.max(0.5, (q.end - q.start) / d * 100) + "%";
      z.title = `${QC_LABEL[q.kind] || q.kind} · ${formatRange(q.start, q.end)}`;
      z.innerHTML = `<span>${esc(QC_LABEL[q.kind] || q.kind)}</span>`;
      wave.appendChild(z);
    });
    notes.forEach((n, i) => {
      if (n.seconds > d) return;
      const m = document.createElement("div");
      m.className = "tp-mk" + (Math.abs(n.seconds - cur()) < 2.5 ? " on" : "");
      m.style.left = (n.seconds / d * 100) + "%";
      m.innerHTML = `<b title="${esc(n.label + " · " + n.text)}">${i + 1}</b>`;
      m.querySelector("b").addEventListener("click", e => { e.stopPropagation(); jumpNote(i); });
      wave.appendChild(m);
    });
  }

  function ruler() {
    const d = dur(), host = $("[data-tp-ruler]");
    if (!d) { host.innerHTML = ""; return; }
    const marks = [0, .2, .4, .6, .8, 1].map(k => `<span>${fmt(d * k)}</span>`).join("");
    host.innerHTML = marks;
  }

  function render() { draw(); layout(); }
  function tick() { render(); if (!audio.paused) raf = requestAnimationFrame(tick); }
  function seek(t) { const d = dur(); if (!d) return; audio.currentTime = Math.max(0, Math.min(d - 0.05, t)); render(); }
  function jumpNote(i) { const n = notes[i]; if (n) seek(Math.max(0, n.seconds - 2)); }
  function step(dir) {
    const t = cur();
    const list = dir > 0 ? notes.filter(n => n.seconds > t + 2.5) : notes.filter(n => n.seconds < t - 3).reverse();
    if (list.length) seek(Math.max(0, list[0].seconds - 2));
  }
  function toggle() {
    if (!blobUrl) return;
    if (audio.paused) audio.play().catch(e => toast(`Не удалось воспроизвести: ${e.message}`, "error"));
    else audio.pause();
  }
  audio.addEventListener("play", () => { playBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>'; playBtn.setAttribute("aria-label", "Пауза"); cancelAnimationFrame(raf); tick(); });
  audio.addEventListener("pause", () => { playBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>'; playBtn.setAttribute("aria-label", "Играть"); cancelAnimationFrame(raf); render(); });
  audio.addEventListener("loadedmetadata", () => { ruler(); render(); });
  audio.addEventListener("seeked", render);

  wave.addEventListener("click", e => {
    const r = wave.getBoundingClientRect();
    seek((e.clientX - r.left) / r.width * dur());
  });
  wave.addEventListener("mousemove", e => {
    const r = wave.getBoundingClientRect(), x = e.clientX - r.left;
    if (!dur()) return;
    hover.hidden = false;
    hover.style.left = x + "px";
    hover.querySelector("span").textContent = fmt(x / r.width * dur());
  });
  wave.addEventListener("mouseleave", () => { hover.hidden = true; });
  playBtn.addEventListener("click", toggle);
  el.querySelectorAll("[data-tp-seek]").forEach(b => b.addEventListener("click", () => seek(cur() + Number(b.dataset.tpSeek))));
  el.querySelectorAll("[data-tp-note]").forEach(b => b.addEventListener("click", () => step(Number(b.dataset.tpNote))));
  $("[data-tp-qcshow]").addEventListener("change", e => { qcShown = e.target.checked; layout(); });
  $("[data-tp-close]").addEventListener("click", () => { destroy(); el.remove(); if (onClose) onClose(); });
  $("[data-tp-qc]").addEventListener("click", async e => {
    if (!file) return;
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = "Слушаю…";
    try {
      const res = await apiPost(`/report/${publicId}/files/${file.id}/qc`, {});
      qc = (res.result && res.result.issues) || [];
      toast(qc.length ? `Нашлось ${qc.length} — отмечены на волне.` : "Замечаний не найдено.", qc.length ? undefined : "success");
      layout();
    } catch (err) {
      toast(`Проверка не удалась: ${err.message}`, "error");
    } finally {
      b.disabled = false;
      b.textContent = "Найти проблемы";
    }
  });
  input.addEventListener("keydown", async e => {
    if (e.key === "Escape") { input.blur(); return; }
    if (e.key !== "Enter") return;
    const text = input.value.trim();
    if (!text) return;
    const at = Math.floor(cur());
    input.disabled = true;
    try {
      await onAddNote(at, text);
      input.value = "";
      toast(`Правка на ${fmt(at)} добавлена.`, "success");
    } catch (err) {
      toast(`Не удалось добавить: ${err.message}`, "error");
    } finally {
      input.disabled = false;
      input.focus();
    }
  });

  // Клавиши — пока плеер на экране и фокус не в поле ввода.
  function onKey(e) {
    if (!el.isConnected) return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const overlays = document.querySelectorAll(".overlay");
    if (overlays.length && !overlays[overlays.length - 1].contains(el)) return;
    if (e.code === "Space") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowLeft" && el.contains(document.activeElement)) { e.preventDefault(); seek(cur() - 5); }
    else if (e.key === "ArrowRight" && el.contains(document.activeElement)) { e.preventDefault(); seek(cur() + 5); }
    else if (e.key === "n" || e.key === "N" || e.key === "т" || e.key === "Т") { e.preventDefault(); input.focus(); }
  }
  document.addEventListener("keydown", onKey);
  const ro = new ResizeObserver(() => render());
  ro.observe(wave);

  function drawFiles() {
    const host = $("[data-tp-files]");
    host.innerHTML = files.map(f => `<button type="button" class="tp-file${file && f.id === file.id ? " on" : ""}" data-tp-file="${f.id}" title="${esc(f.file_name || "")}">${esc(f.file_name || f.file_type)}${f.version > 1 ? ` · v${f.version}` : ""}</button>`).join("");
    host.querySelectorAll("[data-tp-file]").forEach(b => b.addEventListener("click", () => open(Number(b.dataset.tpFile))));
  }

  async function open(fileId) {
    const f = files.find(x => x.id === fileId);
    if (!f || (file && file.id === fileId && blobUrl)) return;
    const keep = cur(), wasPlaying = !audio.paused;
    const seq = ++loadSeq;
    file = f;
    qc = [];
    drawFiles();
    audio.pause();
    playBtn.disabled = true;
    msg.hidden = false;
    msg.textContent = "Готовлю волну…";
    peaks = [];
    const ext = String(f.file_name || "").split(".").pop().toLowerCase();
    const peaksP = apiGet(`/report/${publicId}/files/${f.id}/peaks`).then(p => {
      if (seq !== loadSeq) return;
      peaks = p.peaks || [];
      duration = p.duration || 0;
      ruler(); render();
    }).catch(() => {});
    try {
      const blob = await apiBlob(`/report/${publicId}/files/${f.id}/download`, (got, total) => {
        if (seq !== loadSeq) return;
        msg.textContent = total ? `Загружаю звук… ${Math.round(got / total * 100)}%` : `Загружаю звук… ${(got / 1048576).toFixed(1)} МБ`;
      });
      if (seq !== loadSeq) return;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = URL.createObjectURL(new Blob([blob], { type: MIME[ext] || blob.type || "audio/mpeg" }));
      audio.src = blobUrl;
      await new Promise((res) => { audio.addEventListener("loadedmetadata", res, { once: true }); audio.addEventListener("error", res, { once: true }); });
      if (seq !== loadSeq) return;
      if (audio.error) throw new Error("этот формат не играет — попробуйте mp3 или wav");
      if (keep) audio.currentTime = Math.min(keep, dur() - 0.05);
      await peaksP;
      msg.hidden = true;
      playBtn.disabled = false;
      render();
      if (wasPlaying) audio.play().catch(() => {});
      wave.focus({ preventScroll: true });
    } catch (e) {
      if (seq !== loadSeq) return;
      msg.hidden = false;
      msg.textContent = `Не удалось загрузить звук: ${e.message}`;
    }
  }

  function destroy() {
    loadSeq++;
    audio.pause();
    audio.removeAttribute("src");
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = "";
    cancelAnimationFrame(raf);
    document.removeEventListener("keydown", onKey);
    ro.disconnect();
  }

  return {
    el,
    open,
    destroy,
    setFiles(list) { files = list.filter(isAudioFile); drawFiles(); },
    setNotes(list) {
      notes = list.map(n => { const t = parseNoteTime(n.text); return t ? { seconds: t.seconds, label: t.label, text: t.rest.trim() } : null; })
        .filter(Boolean).sort((a, b) => a.seconds - b.seconds);
      layout();
    },
    refresh() { ruler(); render(); },
  };
}
