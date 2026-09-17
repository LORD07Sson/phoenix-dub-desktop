// «Инструменты ffmpeg» — библиотека операций поверх media_tools.rs:
// обрезка без перекодирования (lossless keyframe cut, как в LosslessCut),
// конвертация, извлечение/нормализация звука, склейка и муксинг
// нескольких файлов. Каждая операция — отдельная панель с обычной формой
// (без «сырого» поля произвольных аргументов ffmpeg), переключаемая
// вкладками внутри одной модалки. Кнопка входа — #open-media-tools в
// шапке, рядом с QC звука.
//
// Файлы выбираются не из каждой вкладки отдельным системным диалогом, а
// один раз в общий пул (см. filePool/poolBarHtml ниже) — панель пула
// видна на любой вкладке, а каждая операция берёт нужный(е) файл(ы) из
// него через <select>. Так один и тот же файл (например, для обрезки
// и следом конвертации) не нужно выбирать заново на каждой вкладке.

import { invoke, openDialog, saveDialog, convertFileSrc, revealInFolder, listen } from "./tauri.js";
import { openSheet, toast } from "./api.js";
import { $, esc, formatTime } from "./utils.js";
import { tagLogger } from "./applog.js";

const mpvLog = tagLogger("mpv");

const VIDEO_EXTENSIONS = ["mp4", "mkv", "mov", "avi", "webm", "m4v"];
const AUDIO_EXTENSIONS = ["wav", "mp3", "flac", "m4a", "aac", "ogg", "opus"];
const SUBTITLE_EXTENSIONS = ["srt", "ass", "ssa", "vtt", "sub"];
const MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];
const POOL_EXTENSIONS = [...MEDIA_EXTENSIONS, ...SUBTITLE_EXTENSIONS];

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

// ============================================================
// Общий пул файлов — раньше каждая вкладка (Обрезка/Конвертация/Аудио/
// Склейка/Муксинг) сама открывала диалог выбора файла, и один и тот же
// файл для двух операций нужно было выбирать дважды. Теперь файлы
// добавляются один раз в общий пул (панель сверху модалки, видна на
// любой вкладке), а каждая операция выбирает нужный(е) файл(ы) из него
// через <select>, не через новый системный диалог.
// ============================================================

const filePool = []; // { path, info } — info может быть null (напр. .srt — ffprobe не видит в нём медиапотока)

// mt_register_media_file — допуск файла в asset-протокол для <video src>
// (см. tauri.conf.json: security.assetProtocol) — делаем на добавление в
// пул один раз, не на каждый выбор в конкретной вкладке.
async function addFilesToPool(extensions) {
  const picked = await openDialog({ multiple: true, filters: [{ name: "Медиа", extensions }] });
  if (!picked) return [];
  const list = Array.isArray(picked) ? picked : [picked];
  const indices = [];
  for (const path of list) {
    const existing = filePool.findIndex(f => f.path === path);
    if (existing !== -1) { indices.push(existing); continue; }
    let info = null;
    try {
      await invoke("mt_register_media_file", { path });
      info = await invoke("mt_probe_media", { path });
    } catch {
      // не медиаконтейнер в понимании ffprobe (например, .srt) —
      // не критично, кладём в пул без метаданных.
    }
    filePool.push({ path, info });
    indices.push(filePool.length - 1);
  }
  return indices;
}

// Убирает файл из пула и подчищает ссылки на него во всех вкладках —
// иначе за отваливающийся путь могли бы держаться cutState.path
// (что-то откроет несуществующий файл) или список склейки/муксинга.
function removeFromPool(index) {
  const removedPath = filePool[index]?.path;
  if (removedPath == null) return;
  filePool.splice(index, 1);
  const reindex = i => (i == null ? i : i === index ? null : i > index ? i - 1 : i);

  if (cutState.path === removedPath) { cutState.path = null; cutState.info = null; cutState.poolIndex = null; closeCutMpv(); }
  else cutState.poolIndex = reindex(cutState.poolIndex);

  if (convertState.path === removedPath) { convertState.path = null; convertState.info = null; convertState.poolIndex = null; }
  else convertState.poolIndex = reindex(convertState.poolIndex);

  if (audioState.path === removedPath) { audioState.path = null; audioState.info = null; audioState.poolIndex = null; }
  else audioState.poolIndex = reindex(audioState.poolIndex);

  concatState.paths = concatState.paths.filter(p => p !== removedPath);
  MUX_SECTIONS.forEach(section => {
    muxState[section.key] = muxState[section.key].filter(t => t.path !== removedPath);
  });
}

function poolBarHtml() {
  return `
    <div class="mt-pool-bar">
      <div class="mt-pool-chips" id="mt-pool-chips">
        ${filePool.length
          ? filePool.map((f, i) => `<span class="mt-pool-chip" title="${esc(f.path)}">${esc(baseName(f.path))}<button class="mt-pool-chip-remove" data-pool-remove="${i}" title="Убрать из пула">✕</button></span>`).join("")
          : `<span class="mt-info-line">Файлов пока нет — добавьте, они станут доступны во всех вкладках.</span>`}
      </div>
      <button class="btn ghost" id="mt-pool-add">📂 Добавить файлы</button>
    </div>`;
}

function wirePoolBar(overlay) {
  overlay.querySelector("#mt-pool-add")?.addEventListener("click", async () => {
    await addFilesToPool(POOL_EXTENSIONS);
    renderPoolBar(overlay);
    renderActivePanel(overlay);
  });
  overlay.querySelectorAll("[data-pool-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      removeFromPool(Number(btn.dataset.poolRemove));
      renderPoolBar(overlay);
      renderActivePanel(overlay);
    });
  });
}

function renderPoolBar(overlay) {
  overlay.querySelector("#mt-pool-bar-mount").innerHTML = poolBarHtml();
  wirePoolBar(overlay);
}

// selectedIndex — какой пункт пула отметить выбранным; filterFn(entry) —
// необязательный предикат, чтобы показать не весь пул (например, только
// файлы со звуковой дорожкой в панели «Аудио»).
function poolSelectHtml(selectId, selectedIndex, filterFn) {
  const options = filePool
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => !filterFn || filterFn(f));
  return `
    <select id="${selectId}" class="mt-pool-select">
      <option value="">— выбрать из пула —</option>
      ${options.map(({ f, i }) => `<option value="${i}" ${i === selectedIndex ? "selected" : ""} title="${esc(f.path)}">${esc(baseName(f.path))}</option>`).join("")}
    </select>`;
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
  poolIndex: null,
  path: null,
  info: null,
  keyframes: [],
  segments: [], // { start, end }
  markIn: null,
  markOut: null,
  // Только для видео — аудиофайлы играют обычным <audio>, см. isVideo()
  // ниже. lastKnownTime обновляется и оптимистично (сразу после клика/
  // сика), и по событию "time-pos" от mpv (mpv-state, см. wireCutPanel) —
  // раньше эту роль играл video.currentTime, mpv сам не даёт синхронный
  // доступ к позиции, только асинхронные события по IPC.
  mpvPaused: true,
  lastKnownTime: 0,
};

// Путь, который сейчас реально загружен в mpv — null, если плеер не
// поднят вовсе (аудио или файл ещё не выбран). Отдельно от cutState,
// потому что переживает полный re-render #mt-body (renderActivePanel
// перерисовывает всё содержимое на каждое действие — добавили сегмент,
// отметили I/O — а окно/процесс mpv должны оставаться тем же самым, не
// пересоздаваться на каждый клик).
let cutMpvLoadedPath = null;
let cutMpvUnlisten = null;

function isVideoFile() {
  return !!(cutState.info && cutState.info.video);
}

// Прямоугольник плейсхолдера в физических пикселях client area главного
// окна — mpv-окно рисуется НАД этим div нативно (см. mpv_embed.rs),
// поэтому HTML тут не рисует ничего своего, только резервирует место.
// Предполагаем, что вебвью занимает весь client area главного окна без
// смещения (decorations:true в tauri.conf.json — заголовок рисует ОС
// СНАРУЖИ client area) — если на реальной машине окажется не так,
// здесь нужна поправка на смещение.
function videoSurfaceRect(root) {
  const el = root.querySelector("#mt-cut-video-surface");
  if (!el) {
    mpvLog.warn("videoSurfaceRect: #mt-cut-video-surface не найден в root");
    return null;
  }
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) {
    mpvLog.warn("videoSurfaceRect: нулевой размер плейсхолдера", r);
    return null;
  }
  const dpr = window.devicePixelRatio || 1;
  return {
    x: Math.round(r.left * dpr),
    y: Math.round(r.top * dpr),
    width: Math.round(r.width * dpr),
    height: Math.round(r.height * dpr),
  };
}

async function syncMpvBounds(root) {
  const rect = videoSurfaceRect(root);
  if (!rect) return;
  mpvLog.info("mpv_create ->", rect);
  try {
    await invoke("mpv_create", rect);
    mpvLog.info("mpv_create ok");
  } catch (e) {
    mpvLog.error("mpv_create failed", e);
    toast(`Не удалось открыть видео-плеер: ${e}`, "error");
  }
}

// Закрывает нативное окно/процесс mpv — обязательно перед сменой файла
// на аудио, переключением на другую операцию и закрытием модалки:
// иначе процесс/окно mpv переживают закрытую панель осиротевшими.
async function closeCutMpv() {
  if (cutMpvUnlisten) { cutMpvUnlisten(); cutMpvUnlisten = null; }
  if (cutMpvLoadedPath == null) return;
  cutMpvLoadedPath = null;
  try { await invoke("mpv_close"); } catch { /* не критично при закрытии */ }
}

async function openCutMpv(root) {
  mpvLog.info("openCutMpv", cutState.path);
  await syncMpvBounds(root);
  if (cutState.path !== cutMpvLoadedPath) {
    cutMpvLoadedPath = cutState.path;
    try {
      await invoke("mpv_load", { path: cutState.path });
      await invoke("mpv_play");
      cutState.mpvPaused = false;
      mpvLog.info("mpv_load + mpv_play ok");
    } catch (e) {
      mpvLog.error("mpv_load/mpv_play failed", e);
      toast(`Не удалось загрузить видео в плеер: ${e}`, "error");
    }
  }
  if (!cutMpvUnlisten) {
    cutMpvUnlisten = await listen("mpv-state", event => {
      const { name, data } = event.payload || {};
      if (name === "time-pos" && typeof data === "number") {
        cutState.lastKnownTime = data;
        drawCutTimeline($("#mt-cut-timeline"));
      } else if (name === "pause") {
        cutState.mpvPaused = !!data;
        const btn = $("#mt-cut-playpause");
        if (btn) btn.textContent = cutState.mpvPaused ? "▶" : "⏸";
      } else if (name === "exited") {
        mpvLog.error("процесс mpv завершился неожиданно (пайп закрылся)");
        toast("Плеер mpv неожиданно завершился.", "error");
        cutMpvLoadedPath = null;
      }
    });
  }
}

async function mpvTogglePlay(root) {
  cutState.mpvPaused = !cutState.mpvPaused;
  const btn = root.querySelector("#mt-cut-playpause");
  if (btn) btn.textContent = cutState.mpvPaused ? "▶" : "⏸";
  try {
    await invoke(cutState.mpvPaused ? "mpv_pause" : "mpv_play");
  } catch (e) {
    toast(`Плеер: ${e}`, "error");
  }
}

async function seekTo(root, seconds) {
  const clamped = Math.max(0, Math.min(cutState.info.duration, seconds));
  cutState.lastKnownTime = clamped;
  drawCutTimeline(root.querySelector("#mt-cut-timeline"));
  if (isVideoFile()) {
    try { await invoke("mpv_seek", { seconds: clamped }); } catch (e) { toast(`Плеер: ${e}`, "error"); }
  } else {
    const media = root.querySelector("#mt-cut-audio");
    if (media) media.currentTime = clamped;
  }
}

function cutPanelHtml() {
  const picker = `<div class="mt-file-row">${poolSelectHtml("mt-cut-pick", cutState.poolIndex, f => f.info && (f.info.video || f.info.audio))}${cutState.path ? infoLineHtml(cutState.info) : ""}</div>`;
  if (!cutState.path) {
    return `
      ${picker}
      <div class="mt-empty">
        <p>Выберите видео или аудиофайл из пула выше — резка идёт без
        перекодирования (мгновенно, без потери качества), начало каждого
        сегмента подъезжает к ближайшему опорному кадру.</p>
      </div>`;
  }
  return `
    ${picker}
    ${isVideoFile()
      ? `<div class="mt-video" id="mt-cut-video-surface"></div>
         <div class="mt-video-controls">
           <button class="icon-btn" id="mt-cut-playpause" title="Play/pause">${cutState.mpvPaused ? "▶" : "⏸"}</button>
           <span class="mt-info-line">mpv</span>
         </div>`
      : `<audio id="mt-cut-audio" src="${esc(convertFileSrc(cutState.path))}" controls style="width:100%;"></audio>`}
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

  // Плейхед — текущая позиция. Для видео это cutState.lastKnownTime
  // (обновляется по событию mpv-state/time-pos и оптимистично при сике —
  // у mpv, в отличие от <video>.currentTime, нет синхронного доступа к
  // позиции), для аудио — сам элемент <audio> даёт currentTime напрямую.
  const audioEl = $("#mt-cut-audio");
  const t = audioEl ? audioEl.currentTime : cutState.lastKnownTime;
  const x = (t / duration) * cssWidth;
  ctx.strokeStyle = "#ffc773";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, cssHeight);
  ctx.stroke();
}

function wireCutPanel(root) {
  const pickSel = root.querySelector("#mt-cut-pick");
  if (pickSel) pickSel.addEventListener("change", async () => {
    if (pickSel.value === "") return;
    const entry = filePool[Number(pickSel.value)];
    const wasVideo = isVideoFile();
    cutState.poolIndex = Number(pickSel.value);
    cutState.path = entry.path;
    cutState.info = entry.info;
    cutState.segments = [];
    cutState.markIn = null;
    cutState.markOut = null;
    cutState.lastKnownTime = 0;
    cutState.mpvPaused = true;
    // Сменили видео на аудио (или наоборот) — старое mpv-окно неоткуда
    // взять новый смысл, закрываем; переоткроется в openCutMpv ниже, если
    // новый файл снова видео.
    if (wasVideo && !(entry.info && entry.info.video)) await closeCutMpv();
    try {
      cutState.keyframes = entry.info && entry.info.video ? await invoke("mt_probe_keyframes", { path: entry.path }) : [];
    } catch {
      cutState.keyframes = [];
    }
    renderActivePanel(root);
  });
  if (!cutState.path) return;

  const canvas = root.querySelector("#mt-cut-timeline");
  const audioEl = root.querySelector("#mt-cut-audio");
  drawCutTimeline(canvas);

  if (isVideoFile()) {
    openCutMpv(root);
    const playBtn = root.querySelector("#mt-cut-playpause");
    if (playBtn) playBtn.addEventListener("click", () => mpvTogglePlay(root));
    // Плейсхолдер пересобирается на каждый re-render (renderActivePanel
    // перерисовывает всё #mt-body) — ResizeObserver навешиваем на новый
    // узел каждый раз; старый просто перестаёт получать события вместе
    // с удалённым узлом, копиться ему не на чём.
    const surface = root.querySelector("#mt-cut-video-surface");
    if (surface && typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => syncMpvBounds(root)).observe(surface);
    }
    // window resize/scroll — глобальные, а не на плейсхолдер, поэтому
    // вешаем один раз на весь модуль-сессию (root = overlay модалки,
    // он не пересобирается на re-render, только #mt-body внутри него) —
    // data-атрибут как флаг «уже подписаны», тот же приём, что и в
    // board.js: wireBoardCards (data-wired guard).
    if (!root.dataset.mpvResizeWired) {
      root.dataset.mpvResizeWired = "1";
      window.addEventListener("resize", () => syncMpvBounds(root));
      root.addEventListener("scroll", () => syncMpvBounds(root), true);
    }
  } else if (audioEl) {
    audioEl.addEventListener("timeupdate", () => drawCutTimeline(canvas));
    audioEl.addEventListener("loadedmetadata", () => drawCutTimeline(canvas));
  }

  canvas.addEventListener("click", e => {
    if (!cutState.info.duration) return;
    const rect = canvas.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    seekTo(root, frac * cutState.info.duration);
  });

  root.querySelector("#mt-mark-in").addEventListener("click", () => {
    cutState.markIn = isVideoFile() ? cutState.lastKnownTime : (audioEl ? audioEl.currentTime : 0);
    renderActivePanel(root);
  });
  root.querySelector("#mt-mark-out").addEventListener("click", () => {
    cutState.markOut = isVideoFile() ? cutState.lastKnownTime : (audioEl ? audioEl.currentTime : 0);
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
      if (s) seekTo(root, s.start);
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

const convertState = { poolIndex: null, path: null, info: null, preset: "mp4_h264" };

function convertPanelHtml() {
  const picker = `<div class="mt-file-row">${poolSelectHtml("mt-convert-pick", convertState.poolIndex, f => f.info && (f.info.video || f.info.audio))}${convertState.path ? infoLineHtml(convertState.info) : ""}</div>`;
  if (!convertState.path) {
    return `
      ${picker}
      <div class="mt-empty">
        <p>Выберите файл из пула выше для перекодирования в другой контейнер/кодек/разрешение.</p>
      </div>`;
  }
  const custom = convertState.preset === "custom";
  return `
    ${picker}
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
  const pickSel = root.querySelector("#mt-convert-pick");
  if (pickSel) pickSel.addEventListener("change", () => {
    if (pickSel.value === "") return;
    const entry = filePool[Number(pickSel.value)];
    convertState.poolIndex = Number(pickSel.value);
    convertState.path = entry.path;
    convertState.info = entry.info;
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
const audioState = { poolIndex: null, path: null, info: null };

function audioPanelHtml() {
  // Фильтр по наличию звуковой дорожки — сразу в самом списке выбора,
  // не отдельной проверкой-тостом после пика, как было раньше.
  const picker = `<div class="mt-file-row">${poolSelectHtml("mt-audio-pick", audioState.poolIndex, f => f.info && f.info.audio)}${audioState.path ? infoLineHtml(audioState.info) : ""}</div>`;
  if (!audioState.path) {
    return `
      ${picker}
      <div class="mt-empty">
        <p>Выберите файл со звуковой дорожкой из пула выше — извлечь звук
        из видео, перевести в другой формат или нормализовать громкость
        (EBU R128 loudnorm).</p>
      </div>`;
  }
  return `
    ${picker}
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
  const pickSel = root.querySelector("#mt-audio-pick");
  if (pickSel) pickSel.addEventListener("change", () => {
    if (pickSel.value === "") return;
    const entry = filePool[Number(pickSel.value)];
    audioState.poolIndex = Number(pickSel.value);
    audioState.path = entry.path;
    audioState.info = entry.info;
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
    <div class="mt-form-row">
      ${poolSelectHtml("mt-concat-pick", null, f => f.info && (f.info.video || f.info.audio))}
      <button class="btn" id="mt-concat-add-picked">+ В список</button>
    </div>
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
    <button class="btn primary" id="mt-concat-run" ${concatState.paths.length >= 2 ? "" : "disabled"}>🧩 Склеить</button>
  `;
}

function wireConcatPanel(root) {
  root.querySelector("#mt-concat-add-picked").addEventListener("click", () => {
    const sel = root.querySelector("#mt-concat-pick");
    if (sel.value === "") { toast("Выберите файл из пула.", "error"); return; }
    concatState.paths.push(filePool[Number(sel.value)].path);
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
        <div class="mt-mux-section-add">
          ${poolSelectHtml(`mt-mux-pick-${section.key}`, null)}
          <button class="btn ghost" data-mux-add="${section.key}">+ Добавить</button>
        </div>
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
    addBtn.addEventListener("click", () => {
      const sel = root.querySelector(`#mt-mux-pick-${section.key}`);
      if (sel.value === "") { toast("Выберите файл из пула.", "error"); return; }
      const path = filePool[Number(sel.value)].path;
      const tracks = muxState[section.key];
      tracks.push({ path, language: "und", title: stemOf(path), isDefault: tracks.length === 0 });
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
    <div id="mt-pool-bar-mount"></div>
    <div class="mt-op-tabs">
      ${Object.entries(OPERATIONS).map(([key, op]) => `<button class="mt-op-tab ${key === activeOp ? "active" : ""}" data-op="${key}">${op.label}</button>`).join("")}
    </div>
    <div id="mt-body"></div>
    <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
  `, "wide");
  // closeCutMpv() — на закрытии модалки и на уходе со вкладки «Обрезка»
  // (переключились на «Конвертацию» — плейсхолдер видео исчез из DOM,
  // нативное окно/процесс mpv без него — осиротевшая утечка).
  overlay.querySelector("[data-close]").addEventListener("click", async () => {
    await closeCutMpv();
    overlay.remove();
  });
  overlay.querySelectorAll(".mt-op-tab").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (activeOp === "cut" && btn.dataset.op !== "cut") await closeCutMpv();
      activeOp = btn.dataset.op;
      overlay.querySelectorAll(".mt-op-tab").forEach(b => b.classList.toggle("active", b === btn));
      renderActivePanel(overlay);
    });
  });
  renderPoolBar(overlay);
  renderActivePanel(overlay);
}

$("#open-media-tools").addEventListener("click", openMediaTools);
