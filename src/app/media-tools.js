// «Инструменты ffmpeg» — библиотека операций поверх media_tools.rs:
// обрезка без перекодирования (lossless keyframe cut, как в LosslessCut),
// конвертация, извлечение/нормализация звука, склейка нескольких файлов.
// Каждая операция — отдельная панель с обычной формой (без «сырого» поля
// произвольных аргументов ffmpeg), переключаемая вкладками внутри одной
// модалки. Кнопка входа — #open-media-tools в шапке, рядом с QC звука.

import { invoke, openDialog, saveDialog, convertFileSrc, revealInFolder, listen } from "./tauri.js";
import { openSheet, toast } from "./api.js";
import { $, esc, formatTime } from "./utils.js";

const VIDEO_EXTENSIONS = ["mp4", "mkv", "mov", "avi", "webm", "m4v"];
const AUDIO_EXTENSIONS = ["wav", "mp3", "flac", "m4a", "aac", "ogg", "opus"];
const SUBTITLE_EXTENSIONS = ["srt", "ass", "ssa", "vtt", "sub"];
const MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];

function baseName(path) {
  return String(path).split(/[\\/]/).pop() || path;
}
function stemOf(path) {
  return baseName(path).replace(/\.[^./\\]+$/, "");
}
function extOf(path) {
  const m = /\.([^./\\]+)$/.exec(baseName(path));
  return m ? m[1].toLowerCase() : "";
}

// Открыть файл выбором пользователя → пустить его в вебвью через
// asset-протокол (mt_register_media_file — без этого <video src> ничего
// не покажет, см. tauri.conf.json: security.assetProtocol) → снять
// метаданные. Общая первая половина у обрезки/конвертации/аудио —
// у склейки свой поток (список файлов, не один).
async function pickAndProbe(extensions) {
  const picked = await openDialog({ multiple: false, filters: [{ name: "Медиа", extensions }] });
  if (!picked) return null;
  const path = Array.isArray(picked) ? picked[0] : picked;
  await invoke("mt_register_media_file", { path });
  const info = await invoke("mt_probe_media", { path });
  return { path, info };
}

function infoLineHtml(info) {
  const parts = [`⏱ ${formatTime(info.duration)}`];
  if (info.video) {
    parts.push(`🎞 ${esc(info.video.codec)}${info.video.width ? ` ${info.video.width}×${info.video.height}` : ""}`);
  }
  if (info.audio) {
    parts.push(`🔊 ${esc(info.audio.codec)}${info.audio.channels ? ` · ${info.audio.channels}ch` : ""}`);
  }
  return `<div class="mt-info-line">${parts.join(" · ")}</div>`;
}

// ============================================================
// Обрезка / трим — keyframe cut, lossless (-c copy), см. cut_media
// в media_tools.rs. Метки I/O — та же идея, что подсказка в самом
// LosslessCut ("i"/"o" для установки точек резки).
// ============================================================

const cutState = {
  path: null,
  info: null,
  keyframes: [],
  segments: [], // { start, end }
  markIn: null,
  markOut: null,
};

function cutPanelHtml() {
  if (!cutState.path) {
    return `
      <div class="mt-empty">
        <p>Выберите видео или аудиофайл — резка идёт без перекодирования
        (мгновенно, без потери качества), начало каждого сегмента
        подъезжает к ближайшему опорному кадру.</p>
        <button class="btn primary" id="mt-cut-pick">📂 Выбрать файл</button>
      </div>`;
  }
  return `
    <div class="mt-file-row">
      <span title="${esc(cutState.path)}">${esc(baseName(cutState.path))}</span>
      ${infoLineHtml(cutState.info)}
      <button class="btn ghost" id="mt-cut-pick">Сменить файл</button>
    </div>
    ${cutState.info.video ? `<video class="mt-video" id="mt-cut-video" src="${esc(convertFileSrc(cutState.path))}" controls></video>` : `<audio id="mt-cut-video" src="${esc(convertFileSrc(cutState.path))}" controls style="width:100%;"></audio>`}
    <canvas class="mt-timeline" id="mt-cut-timeline"></canvas>
    <div class="mt-io-row">
      <button class="btn" id="mt-mark-in">⏮ I — отметить начало</button>
      <span id="mt-mark-in-val">${cutState.markIn == null ? "—" : formatTime(cutState.markIn)}</span>
      <button class="btn" id="mt-mark-out">⏭ O — отметить конец</button>
      <span id="mt-mark-out-val">${cutState.markOut == null ? "—" : formatTime(cutState.markOut)}</span>
      <button class="btn primary" id="mt-add-segment">+ Добавить сегмент</button>
    </div>
    <div class="mt-segment-list" id="mt-segment-list">
      ${cutState.segments.length ? cutState.segments.map((s, i) => `
        <div class="mt-segment-row" data-i="${i}">
          <span>${i + 1}.</span>
          <span>${formatTime(s.start)} – ${formatTime(s.end)}</span>
          <span class="mt-segment-dur">(${formatTime(s.end - s.start)})</span>
          <button class="icon-btn" data-seek-segment="${i}" title="Перейти">▶</button>
          <button class="icon-btn" data-remove-segment="${i}" title="Удалить">✕</button>
        </div>`).join("") : `<div class="no-assignee">Пока нет сегментов — отметьте I/O и добавьте.</div>`}
    </div>
    <div class="mt-export-row">
      <label><input type="checkbox" id="mt-keep-separate" checked> Экспортировать сегменты отдельно</label>
      <label><input type="checkbox" id="mt-merge"> Склеить всё в один файл</label>
      <button class="btn primary" id="mt-cut-export" ${cutState.segments.length ? "" : "disabled"}>✂ Экспортировать</button>
    </div>
    <div class="update-progress-track" id="mt-cut-progress-track" hidden><div class="update-progress-fill" id="mt-cut-progress-fill"></div></div>
  `;
}

function drawCutTimeline(canvas) {
  if (!canvas || !cutState.info) return;
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 560;
  const cssHeight = 44;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const duration = cutState.info.duration || 1;
  ctx.fillStyle = "#251a20";
  ctx.fillRect(0, cssHeight / 2 - 3, cssWidth, 6);

  // Сегменты — заливка полосой во всю высоту.
  cutState.segments.forEach(s => {
    const x1 = (s.start / duration) * cssWidth;
    const x2 = (s.end / duration) * cssWidth;
    ctx.fillStyle = "rgba(255, 106, 77, .35)";
    ctx.fillRect(x1, 4, Math.max(1.5, x2 - x1), cssHeight - 8);
  });

  // Засечки опорных кадров — тонкие вертикальные штрихи.
  ctx.strokeStyle = "rgba(255,255,255,.25)";
  ctx.lineWidth = 1;
  cutState.keyframes.forEach(k => {
    const x = (k / duration) * cssWidth;
    ctx.beginPath();
    ctx.moveTo(x, cssHeight - 8);
    ctx.lineTo(x, cssHeight);
    ctx.stroke();
  });

  // Незакоммиченные метки I/O.
  const drawMark = (t, color) => {
    if (t == null) return;
    const x = (t / duration) * cssWidth;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, cssHeight);
    ctx.stroke();
  };
  drawMark(cutState.markIn, "#6bc694");
  drawMark(cutState.markOut, "#ff8b82");

  // Плейхед — текущая позиция видео/аудио.
  const media = $("#mt-cut-video");
  if (media) {
    const x = (media.currentTime / duration) * cssWidth;
    ctx.strokeStyle = "#ffc773";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, cssHeight);
    ctx.stroke();
  }
}

function wireCutPanel(root) {
  const pickBtn = root.querySelector("#mt-cut-pick");
  if (pickBtn) pickBtn.addEventListener("click", async () => {
    const picked = await pickAndProbe(MEDIA_EXTENSIONS);
    if (!picked) return;
    cutState.path = picked.path;
    cutState.info = picked.info;
    cutState.segments = [];
    cutState.markIn = null;
    cutState.markOut = null;
    try {
      cutState.keyframes = picked.info.video ? await invoke("mt_probe_keyframes", { path: picked.path }) : [];
    } catch {
      cutState.keyframes = [];
    }
    renderActivePanel(root);
  });
  if (!cutState.path) return;

  const media = root.querySelector("#mt-cut-video");
  const canvas = root.querySelector("#mt-cut-timeline");
  drawCutTimeline(canvas);
  if (media) {
    media.addEventListener("timeupdate", () => drawCutTimeline(canvas));
    media.addEventListener("loadedmetadata", () => drawCutTimeline(canvas));
  }
  canvas.addEventListener("click", e => {
    if (!media || !cutState.info.duration) return;
    const rect = canvas.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    media.currentTime = Math.max(0, Math.min(cutState.info.duration, frac * cutState.info.duration));
  });

  root.querySelector("#mt-mark-in").addEventListener("click", () => {
    cutState.markIn = media ? media.currentTime : 0;
    renderActivePanel(root);
  });
  root.querySelector("#mt-mark-out").addEventListener("click", () => {
    cutState.markOut = media ? media.currentTime : 0;
    renderActivePanel(root);
  });
  root.querySelector("#mt-add-segment").addEventListener("click", () => {
    if (cutState.markIn == null || cutState.markOut == null) {
      toast("Отметьте и начало (I), и конец (O) сегмента.", "error");
      return;
    }
    const start = Math.min(cutState.markIn, cutState.markOut);
    const end = Math.max(cutState.markIn, cutState.markOut);
    if (end - start < 0.05) {
      toast("Сегмент слишком короткий.", "error");
      return;
    }
    cutState.segments.push({ start, end });
    cutState.segments.sort((a, b) => a.start - b.start);
    cutState.markIn = null;
    cutState.markOut = null;
    renderActivePanel(root);
  });
  root.querySelectorAll("[data-seek-segment]").forEach(btn => {
    btn.addEventListener("click", () => {
      const s = cutState.segments[Number(btn.dataset.seekSegment)];
      if (media && s) media.currentTime = s.start;
    });
  });
  root.querySelectorAll("[data-remove-segment]").forEach(btn => {
    btn.addEventListener("click", () => {
      cutState.segments.splice(Number(btn.dataset.removeSegment), 1);
      renderActivePanel(root);
    });
  });

  root.querySelector("#mt-cut-export").addEventListener("click", async () => {
    const keepSeparate = root.querySelector("#mt-keep-separate").checked;
    const merge = root.querySelector("#mt-merge").checked;
    if (!keepSeparate && !merge) {
      toast("Выберите хотя бы один вариант экспорта.", "error");
      return;
    }
    const outDir = await openDialog({ directory: true });
    if (!outDir) return;
    const btn = root.querySelector("#mt-cut-export");
    btn.disabled = true;
    btn.textContent = "Режу…";
    try {
      const result = await invoke("mt_cut_media", {
        path: cutState.path,
        segments: cutState.segments,
        outDir,
        keepSeparate,
        merge,
      });
      const count = result.segmentPaths.length + (result.mergedPath ? 1 : 0);
      toast(`Готово: ${count} файл(ов).`, "success", {
        label: "📂 Показать в папке",
        onClick: () => revealInFolder(result.mergedPath || result.segmentPaths[0] || outDir),
      });
    } catch (e) {
      toast(`Не удалось вырезать: ${e}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "✂ Экспортировать";
    }
  });
}

// ============================================================
// Конвертация / транскод — см. transcode_media в media_tools.rs.
// ============================================================

const CONVERT_PRESETS = {
  mp4_h264: { label: "MP4 (H.264/AAC) — универсальный", container: "mp4", opts: { videoCodec: "libx264", audioCodec: "aac", crf: 23 } },
  telegram: { label: "Сжать для Telegram (720p, ~2 Мбит/с)", container: "mp4", opts: { videoCodec: "libx264", audioCodec: "aac", height: 720, videoBitrate: "2M", audioBitrate: "128k" } },
  webm_vp9: { label: "WebM (VP9/Opus)", container: "webm", opts: { videoCodec: "libvpx-vp9", audioCodec: "libopus", crf: 32 } },
  custom: { label: "Свои параметры", container: "mp4", opts: {} },
};

const convertState = { path: null, info: null, preset: "mp4_h264" };

function convertPanelHtml() {
  if (!convertState.path) {
    return `
      <div class="mt-empty">
        <p>Выберите файл для перекодирования в другой контейнер/кодек/разрешение.</p>
        <button class="btn primary" id="mt-convert-pick">📂 Выбрать файл</button>
      </div>`;
  }
  const custom = convertState.preset === "custom";
  return `
    <div class="mt-file-row">
      <span title="${esc(convertState.path)}">${esc(baseName(convertState.path))}</span>
      ${infoLineHtml(convertState.info)}
      <button class="btn ghost" id="mt-convert-pick">Сменить файл</button>
    </div>
    <div class="mt-form-row">
      <span>Пресет</span>
      <select id="mt-convert-preset">
        ${Object.entries(CONVERT_PRESETS).map(([k, p]) => `<option value="${k}" ${k === convertState.preset ? "selected" : ""}>${esc(p.label)}</option>`).join("")}
      </select>
    </div>
    <div id="mt-convert-custom" ${custom ? "" : "hidden"}>
      <div class="mt-form-row"><span>Видео-кодек</span>
        <select id="mt-c-vcodec"><option value="">не менять</option><option value="libx264">H.264</option><option value="libx265">H.265</option><option value="libvpx-vp9">VP9</option></select>
      </div>
      <div class="mt-form-row"><span>Аудио-кодек</span>
        <select id="mt-c-acodec"><option value="">не менять</option><option value="aac">AAC</option><option value="libopus">Opus</option><option value="mp3">MP3</option></select>
      </div>
      <div class="mt-form-row"><span>Ширина / высота (px)</span>
        <input id="mt-c-width" type="number" min="1" placeholder="авто" style="width:90px;">
        <input id="mt-c-height" type="number" min="1" placeholder="авто" style="width:90px;">
      </div>
      <div class="mt-form-row"><span>Битрейт видео / аудио</span>
        <input id="mt-c-vbitrate" type="text" placeholder="напр. 2M" style="width:90px;">
        <input id="mt-c-abitrate" type="text" placeholder="напр. 128k" style="width:90px;">
      </div>
      <div class="mt-form-row"><span>CRF (качество, меньше — лучше)</span>
        <input id="mt-c-crf" type="number" min="0" max="51" placeholder="напр. 23" style="width:90px;">
      </div>
    </div>
    <div class="mt-form-row">
      <span>Контейнер результата</span>
      <select id="mt-convert-container">
        ${["mp4", "mkv", "mov", "webm"].map(c => `<option value="${c}" ${c === CONVERT_PRESETS[convertState.preset].container ? "selected" : ""}>${c}</option>`).join("")}
      </select>
    </div>
    <button class="btn primary" id="mt-convert-run">🔄 Конвертировать</button>
    <div class="update-progress-track" id="mt-convert-progress-track" hidden><div class="update-progress-fill" id="mt-convert-progress-fill"></div></div>
  `;
}

function wireConvertPanel(root) {
  const pickBtn = root.querySelector("#mt-convert-pick");
  if (pickBtn) pickBtn.addEventListener("click", async () => {
    const picked = await pickAndProbe(MEDIA_EXTENSIONS);
    if (!picked) return;
    convertState.path = picked.path;
    convertState.info = picked.info;
    renderActivePanel(root);
  });
  if (!convertState.path) return;

  root.querySelector("#mt-convert-preset").addEventListener("change", e => {
    convertState.preset = e.target.value;
    renderActivePanel(root);
  });

  root.querySelector("#mt-convert-run").addEventListener("click", async () => {
    const preset = CONVERT_PRESETS[convertState.preset];
    const opts = convertState.preset === "custom" ? {
      videoCodec: root.querySelector("#mt-c-vcodec").value || null,
      audioCodec: root.querySelector("#mt-c-acodec").value || null,
      width: Number(root.querySelector("#mt-c-width").value) || null,
      height: Number(root.querySelector("#mt-c-height").value) || null,
      videoBitrate: root.querySelector("#mt-c-vbitrate").value || null,
      audioBitrate: root.querySelector("#mt-c-abitrate").value || null,
      crf: Number(root.querySelector("#mt-c-crf").value) || null,
    } : preset.opts;
    const container = root.querySelector("#mt-convert-container").value;
    const outPath = await saveDialog({ defaultPath: `${stemOf(convertState.path)}.${container}` });
    if (!outPath) return;

    const btn = root.querySelector("#mt-convert-run");
    const track = root.querySelector("#mt-convert-progress-track");
    const fill = root.querySelector("#mt-convert-progress-fill");
    btn.disabled = true;
    track.hidden = false;
    const unlisten = await listen("mediatool-progress", event => {
      fill.style.width = `${Math.round((event.payload || 0) * 100)}%`;
    });
    try {
      await invoke("mt_transcode_media", { path: convertState.path, outPath, opts });
      toast("Конвертация завершена.", "success", { label: "📂 Показать в папке", onClick: () => revealInFolder(outPath) });
    } catch (e) {
      toast(`Не удалось конвертировать: ${e}`, "error");
    } finally {
      unlisten();
      btn.disabled = false;
      track.hidden = true;
      fill.style.width = "0%";
    }
  });
}

// ============================================================
// Аудио — извлечь/конвертировать/нормализовать, см. extract_audio.
// ============================================================

const AUDIO_CODEC_EXT = { copy: null, aac: "m4a", mp3: "mp3", flac: "flac", libopus: "opus" };
const audioState = { path: null, info: null };

function audioPanelHtml() {
  if (!audioState.path) {
    return `
      <div class="mt-empty">
        <p>Извлечь звук из видео, перевести в другой формат или
        нормализовать громкость (EBU R128 loudnorm).</p>
        <button class="btn primary" id="mt-audio-pick">📂 Выбрать файл</button>
      </div>`;
  }
  return `
    <div class="mt-file-row">
      <span title="${esc(audioState.path)}">${esc(baseName(audioState.path))}</span>
      ${infoLineHtml(audioState.info)}
      <button class="btn ghost" id="mt-audio-pick">Сменить файл</button>
    </div>
    <div class="mt-form-row">
      <span>Кодек</span>
      <select id="mt-audio-codec">
        <option value="copy">Как есть (без перекодирования)</option>
        <option value="aac">AAC (.m4a)</option>
        <option value="mp3">MP3</option>
        <option value="flac">FLAC (без потерь)</option>
        <option value="libopus">Opus</option>
      </select>
    </div>
    <div class="mt-form-row">
      <span>Битрейт</span>
      <input id="mt-audio-bitrate" type="text" placeholder="напр. 192k (пусто — по умолчанию)" style="width:160px;">
    </div>
    <div class="mt-form-row">
      <label><input type="checkbox" id="mt-audio-normalize"> Нормализовать громкость (loudnorm)</label>
    </div>
    <button class="btn primary" id="mt-audio-run">🎵 Извлечь / конвертировать</button>
  `;
}

function wireAudioPanel(root) {
  const pickBtn = root.querySelector("#mt-audio-pick");
  if (pickBtn) pickBtn.addEventListener("click", async () => {
    const picked = await pickAndProbe(MEDIA_EXTENSIONS);
    if (!picked) return;
    if (!picked.info.audio) {
      toast("В этом файле не найдено звуковой дорожки.", "error");
      return;
    }
    audioState.path = picked.path;
    audioState.info = picked.info;
    renderActivePanel(root);
  });
  if (!audioState.path) return;

  root.querySelector("#mt-audio-codec").addEventListener("change", e => {
    const normalize = root.querySelector("#mt-audio-normalize");
    if (e.target.value === "copy" && normalize.checked) {
      toast("«Как есть» несовместимо с нормализацией — переключаю на AAC.", "info");
    }
  });

  root.querySelector("#mt-audio-run").addEventListener("click", async () => {
    const codec = root.querySelector("#mt-audio-codec").value;
    const bitrate = root.querySelector("#mt-audio-bitrate").value.trim() || null;
    const normalize = root.querySelector("#mt-audio-normalize").checked;
    const effectiveExt = AUDIO_CODEC_EXT[codec] || (normalize ? "m4a" : extOf(audioState.path)) || "m4a";
    const outPath = await saveDialog({ defaultPath: `${stemOf(audioState.path)}.${effectiveExt}` });
    if (!outPath) return;

    const btn = root.querySelector("#mt-audio-run");
    btn.disabled = true;
    btn.textContent = "Обрабатываю…";
    try {
      await invoke("mt_extract_audio", { path: audioState.path, outPath, opts: { codec, bitrate, normalize } });
      toast("Готово.", "success", { label: "📂 Показать в папке", onClick: () => revealInFolder(outPath) });
    } catch (e) {
      toast(`Не удалось обработать звук: ${e}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "🎵 Извлечь / конвертировать";
    }
  });
}

// ============================================================
// Склейка — см. concat_media в media_tools.rs (сам решает copy/re-encode).
// ============================================================

const concatState = { paths: [] };

function concatPanelHtml() {
  return `
    <div class="mt-concat-list" id="mt-concat-list">
      ${concatState.paths.length ? concatState.paths.map((p, i) => `
        <div class="mt-segment-row" data-i="${i}">
          <span>${i + 1}.</span>
          <span title="${esc(p)}" style="flex:1; overflow:hidden; text-overflow:ellipsis;">${esc(baseName(p))}</span>
          <button class="icon-btn" data-move-up="${i}" title="Выше" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="icon-btn" data-move-down="${i}" title="Ниже" ${i === concatState.paths.length - 1 ? "disabled" : ""}>↓</button>
          <button class="icon-btn" data-remove-concat="${i}" title="Убрать">✕</button>
        </div>`).join("") : `<div class="no-assignee">Добавьте хотя бы два файла — порядок в списке и есть порядок склейки.</div>`}
    </div>
    <button class="btn" id="mt-concat-add">📂 Добавить файл(ы)</button>
    <button class="btn primary" id="mt-concat-run" ${concatState.paths.length >= 2 ? "" : "disabled"}>🧩 Склеить</button>
  `;
}

function wireConcatPanel(root) {
  root.querySelector("#mt-concat-add").addEventListener("click", async () => {
    const picked = await openDialog({ multiple: true, filters: [{ name: "Медиа", extensions: MEDIA_EXTENSIONS }] });
    if (!picked) return;
    const list = Array.isArray(picked) ? picked : [picked];
    concatState.paths.push(...list);
    renderActivePanel(root);
  });
  root.querySelectorAll("[data-remove-concat]").forEach(btn => {
    btn.addEventListener("click", () => {
      concatState.paths.splice(Number(btn.dataset.removeConcat), 1);
      renderActivePanel(root);
    });
  });
  root.querySelectorAll("[data-move-up]").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.moveUp);
      [concatState.paths[i - 1], concatState.paths[i]] = [concatState.paths[i], concatState.paths[i - 1]];
      renderActivePanel(root);
    });
  });
  root.querySelectorAll("[data-move-down]").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.moveDown);
      [concatState.paths[i + 1], concatState.paths[i]] = [concatState.paths[i], concatState.paths[i + 1]];
      renderActivePanel(root);
    });
  });
  const runBtn = root.querySelector("#mt-concat-run");
  if (runBtn) runBtn.addEventListener("click", async () => {
    const ext = extOf(concatState.paths[0]) || "mp4";
    const outPath = await saveDialog({ defaultPath: `merged.${ext}` });
    if (!outPath) return;
    runBtn.disabled = true;
    runBtn.textContent = "Склеиваю…";
    try {
      const mode = await invoke("mt_concat_media", { paths: concatState.paths, outPath });
      toast(
        mode === "copy" ? "Склеено без перекодирования (файлы совпадали по кодекам)." : "Склеено с перекодированием (кодеки/разрешение входов отличались).",
        "success",
        { label: "📂 Показать в папке", onClick: () => revealInFolder(outPath) },
      );
    } catch (e) {
      toast(`Не удалось склеить: ${e}`, "error");
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "🧩 Склеить";
    }
  });
}

// ============================================================
// Муксинг — собрать видео + несколько дублей аудио (каждый уже свой
// файл, как хранит студия) + субтитры в один контейнер с языком/именем/
// флагом "по умолчанию" на дорожку, без перекодирования. См. mux_media
// в media_tools.rs. Разметка секций — по образцу референса пользователя
// (Leo MultiTools): Видео/Аудио/Субтитры отдельными группами, у каждой
// дорожки свой язык + имя + переключатель "по умолч.".
// ============================================================

const LANGUAGE_OPTIONS = [
  { code: "und", label: "Не указан" },
  { code: "rus", label: "Русский" },
  { code: "eng", label: "Английский" },
  { code: "jpn", label: "Японский" },
  { code: "chi", label: "Китайский" },
  { code: "kor", label: "Корейский" },
  { code: "ger", label: "Немецкий" },
  { code: "fre", label: "Французский" },
  { code: "spa", label: "Испанский" },
];

const MUX_SECTIONS = [
  { kind: "video", key: "video", label: "Видео", letter: "V", extensions: VIDEO_EXTENSIONS },
  { kind: "audio", key: "audio", label: "Аудио", letter: "A", extensions: AUDIO_EXTENSIONS },
  { kind: "subtitle", key: "subtitle", label: "Субтитры", letter: "S", extensions: SUBTITLE_EXTENSIONS },
];

// Один файл — одна дорожка (без склейки нескольких файлов в одну
// дорожку, в отличие от референса, где под "V1" может быть несколько
// файлов сразу) — это покрывает реальный сценарий студии: у каждого
// дубляжа/сабов свой отдельный файл.
const muxState = { video: [], audio: [], subtitle: [] };

function muxTrackRowHtml(section, track, i) {
  return `
    <div class="mt-mux-row">
      <span class="mt-mux-label">${section.letter}${i + 1}</span>
      <span class="mt-mux-file" title="${esc(track.path)}">${esc(baseName(track.path))}</span>
      <select data-mux-lang data-section="${section.key}" data-i="${i}">
        ${LANGUAGE_OPTIONS.map(l => `<option value="${l.code}" ${l.code === track.language ? "selected" : ""}>${esc(l.label)}</option>`).join("")}
      </select>
      <input type="text" data-mux-title data-section="${section.key}" data-i="${i}" value="${esc(track.title)}" placeholder="Имя дорожки">
      <label class="mt-mux-default-toggle"><input type="checkbox" data-mux-default data-section="${section.key}" data-i="${i}" ${track.isDefault ? "checked" : ""}> По умолч.</label>
      <button class="icon-btn" data-mux-remove data-section="${section.key}" data-i="${i}" title="Убрать">✕</button>
    </div>`;
}

function muxSectionHtml(section) {
  const tracks = muxState[section.key];
  return `
    <div class="mt-mux-section">
      <div class="mt-mux-section-head">
        <b>${esc(section.label)}</b>
        <button class="btn ghost" data-mux-add="${section.key}">+ Добавить</button>
      </div>
      ${tracks.length ? tracks.map((t, i) => muxTrackRowHtml(section, t, i)).join("") : `<div class="no-assignee">Пусто</div>`}
    </div>`;
}

function totalMuxTracks() {
  return muxState.video.length + muxState.audio.length + muxState.subtitle.length;
}

function muxPanelHtml() {
  return `
    ${MUX_SECTIONS.map(muxSectionHtml).join("")}
    <button class="btn primary" id="mt-mux-run" ${totalMuxTracks() ? "" : "disabled"}>🧩 Смуксить</button>
  `;
}

function wireMuxPanel(root) {
  MUX_SECTIONS.forEach(section => {
    const addBtn = root.querySelector(`[data-mux-add="${section.key}"]`);
    if (!addBtn) return;
    addBtn.addEventListener("click", async () => {
      const picked = await openDialog({ multiple: true, filters: [{ name: section.label, extensions: section.extensions }] });
      if (!picked) return;
      const list = Array.isArray(picked) ? picked : [picked];
      const tracks = muxState[section.key];
      for (const path of list) {
        tracks.push({ path, language: "und", title: stemOf(path), isDefault: tracks.length === 0 });
      }
      renderActivePanel(root);
    });
  });

  root.querySelectorAll("[data-mux-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      muxState[btn.dataset.section].splice(Number(btn.dataset.i), 1);
      renderActivePanel(root);
    });
  });
  root.querySelectorAll("[data-mux-lang]").forEach(sel => {
    sel.addEventListener("change", () => {
      muxState[sel.dataset.section][Number(sel.dataset.i)].language = sel.value;
    });
  });
  root.querySelectorAll("[data-mux-title]").forEach(inp => {
    inp.addEventListener("input", () => {
      muxState[inp.dataset.section][Number(inp.dataset.i)].title = inp.value;
    });
  });
  // Флаг "по умолчанию" — не больше одной дорожки на раздел (видео,
  // аудио, субтитры отдельно), поэтому включение одной сбрасывает
  // остальные в том же разделе; ре-рендер нужен, чтобы их чекбоксы
  // визуально сняли отметку.
  root.querySelectorAll("[data-mux-default]").forEach(cb => {
    cb.addEventListener("change", () => {
      const section = cb.dataset.section;
      const i = Number(cb.dataset.i);
      muxState[section].forEach((t, idx) => { t.isDefault = idx === i && cb.checked; });
      renderActivePanel(root);
    });
  });

  const runBtn = root.querySelector("#mt-mux-run");
  if (!runBtn) return;
  runBtn.addEventListener("click", async () => {
    const tracks = MUX_SECTIONS.flatMap(section => muxState[section.key].map(t => ({
      path: t.path, kind: section.kind, language: t.language, title: t.title, isDefault: t.isDefault,
    })));
    if (!tracks.length) return;
    const outPath = await saveDialog({ defaultPath: "muxed.mkv", filters: [{ name: "Matroska", extensions: ["mkv"] }] });
    if (!outPath) return;
    runBtn.disabled = true;
    runBtn.textContent = "Муксирую…";
    try {
      await invoke("mt_mux_media", { tracks, outPath });
      toast("Готово.", "success", { label: "📂 Показать в папке", onClick: () => revealInFolder(outPath) });
    } catch (e) {
      toast(`Не удалось смуксить: ${e}`, "error");
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "🧩 Смуксить";
    }
  });
}

// ============================================================
// Общий каркас модалки — реестр операций (переключатель вкладок).
// Добавить новую операцию позже = ещё одна запись здесь + свой
// html()/wire(), остальное не трогается.
// ============================================================

const OPERATIONS = {
  cut: { label: "✂️ Обрезка", html: cutPanelHtml, wire: wireCutPanel },
  convert: { label: "🔄 Конвертация", html: convertPanelHtml, wire: wireConvertPanel },
  audio: { label: "🎵 Аудио", html: audioPanelHtml, wire: wireAudioPanel },
  concat: { label: "🧩 Склейка", html: concatPanelHtml, wire: wireConcatPanel },
  mux: { label: "🎛 Муксинг", html: muxPanelHtml, wire: wireMuxPanel },
};

let activeOp = "cut";

function renderActivePanel(overlay) {
  const body = overlay.querySelector("#mt-body");
  body.innerHTML = OPERATIONS[activeOp].html();
  OPERATIONS[activeOp].wire(overlay);
}

export function openMediaTools() {
  const overlay = openSheet(`
    <h2>🎬 Инструменты ffmpeg</h2>
    <div class="mt-op-tabs">
      ${Object.entries(OPERATIONS).map(([key, op]) => `<button class="mt-op-tab ${key === activeOp ? "active" : ""}" data-op="${key}">${op.label}</button>`).join("")}
    </div>
    <div id="mt-body"></div>
    <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
  `, "wide");
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  overlay.querySelectorAll(".mt-op-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      activeOp = btn.dataset.op;
      overlay.querySelectorAll(".mt-op-tab").forEach(b => b.classList.toggle("active", b === btn));
      renderActivePanel(overlay);
    });
  });
  renderActivePanel(overlay);
}

$("#open-media-tools").addEventListener("click", openMediaTools);
