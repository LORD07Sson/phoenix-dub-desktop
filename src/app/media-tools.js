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
//
// Диалоги выбора файлов открывает Rust (pickInputFiles/pickOutputFile/
// pickOutputDir в tauri.js), а не JS-плагин: бэкенд должен САМ знать,
// какие пути пользователь разрешил трогать, иначе любая команда
// становится «прочитай/перезапиши что скажут» — см. file_scope.rs.

import {
  invoke, pickInputFiles, pickOutputFile, pickOutputDir,
  convertFileSrc, revealInFolder, listen,
} from "./tauri.js";
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

// Длительность с долями секунды — на укладке дубляжа «0:04» и «0:04.7»
// это разные места, а formatTime() из utils.js округляет до секунды.
function formatTimePrecise(sec) {
  if (!Number.isFinite(sec)) return "0:00.0";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
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
  const list = await pickInputFiles({ multiple: true, filters: [{ name: "Медиа", extensions }] });
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
    parts.push(`🎞 ${esc(info.video.codec)}${info.video.width ? ` ${info.video.width}×${info.video.height}` : ""}${info.video.fps ? ` · ${info.video.fps.toFixed(2)} fps` : ""}`);
  }
  if (info.audio) {
    parts.push(`🔊 ${esc(info.audio.codec)}${info.audio.channels ? ` · ${info.audio.channels}ch` : ""}${info.audio.sampleRate ? ` · ${Math.round(info.audio.sampleRate / 1000)} кГц` : ""}`);
  }
  return `<div class="mt-info-line">${parts.join(" · ")}</div>`;
}

// ============================================================
// Общий бегунок длинных операций.
//
// Раньше прогресс был только у конвертации, а остановить начатое было
// нельзя вовсе: единственным способом прервать сорокаминутный транскод
// оставалось закрыть приложение — и даже это оставляло ffmpeg дожёвывать
// файл в фоне. Теперь любая операция идёт через runJob: одна полоса с
// подписью текущего прохода («Сегмент 3 из 7», «Измеряю громкость») и
// кнопка «Отмена», которая доходит до самого процесса (mt_cancel).
// ============================================================

// Параллельно две операции ffmpeg запускать нечем (бэкенд держит один
// текущий процесс) — и незачем: они делят диск и процессор.
let jobRunning = false;

function jobHtml() {
  return `
    <div class="mt-job" id="mt-job" hidden>
      <div class="mt-job-head">
        <span class="mt-job-label" id="mt-job-label"></span>
        <span class="mt-job-pct" id="mt-job-pct">0%</span>
      </div>
      <div class="update-progress-track"><div class="update-progress-fill" id="mt-job-fill"></div></div>
      <button class="btn ghost mt-job-cancel" id="mt-job-cancel" type="button">✕ Отмена</button>
    </div>`;
}

/**
 * Выполняет длинную операцию с общей полосой прогресса и отменой.
 * button — кнопка запуска (блокируется и меняет подпись на время работы).
 */
async function runJob(overlay, { button, busyLabel, run }) {
  if (jobRunning) {
    toast("Дождитесь окончания текущей операции.", "error");
    return null;
  }
  const box = overlay.querySelector("#mt-job");
  const fill = overlay.querySelector("#mt-job-fill");
  const pct = overlay.querySelector("#mt-job-pct");
  const label = overlay.querySelector("#mt-job-label");
  const cancelBtn = overlay.querySelector("#mt-job-cancel");

  const idleLabel = button ? button.textContent : "";
  jobRunning = true;
  if (button) { button.disabled = true; button.textContent = busyLabel; }
  box.hidden = false;
  fill.style.width = "0%";
  pct.textContent = "0%";
  label.textContent = busyLabel;
  cancelBtn.disabled = false;

  const onCancel = async () => {
    cancelBtn.disabled = true;
    label.textContent = "Останавливаю…";
    try { await invoke("mt_cancel"); } catch (e) { toast(String(e), "error"); cancelBtn.disabled = false; }
  };
  cancelBtn.addEventListener("click", onCancel);

  const unlisten = await listen("mediatool-progress", event => {
    const { fraction = 0, label: stage = "" } = event.payload || {};
    const percent = Math.round(fraction * 100);
    fill.style.width = `${percent}%`;
    pct.textContent = `${percent}%`;
    if (stage) label.textContent = stage;
  });

  try {
    return await run();
  } catch (e) {
    // Отмена — это не сбой: пользователь сам нажал кнопку, ругаться
    // красным тостом на собственное действие незачем.
    if (String(e).includes("отменена")) toast("Операция отменена.");
    else toast(String(e), "error");
    return null;
  } finally {
    unlisten();
    cancelBtn.removeEventListener("click", onCancel);
    box.hidden = true;
    jobRunning = false;
    if (button) { button.disabled = false; button.textContent = idleLabel; }
  }
}

// Успешный результат — с кнопкой «показать в папке», один хелпер на все
// операции вместо пяти одинаковых блоков.
function toastDone(text, path) {
  toast(text, "success", { label: "📂 Показать в папке", onClick: () => revealInFolder(path) });
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
  // Длительность от самого mpv точнее, чем от ffprobe, на файлах с
  // кривым контейнером; ffprobe-значение остаётся запасным.
  mpvDuration: null,
  // Громкость/скорость живут между файлами: выставил один раз — работает
  // дальше, а не сбрасывается на каждый новый дубль.
  volume: 100,
  muted: false,
  speed: 1,
};

function cutDuration() {
  return cutState.mpvDuration || (cutState.info && cutState.info.duration) || 0;
}

// Путь, который сейчас реально загружен в mpv — null, если плеер не
// поднят вовсе (аудио или файл ещё не выбран). Отдельно от cutState,
// потому что переживает перерисовку панели: нативное окно/процесс mpv
// должны оставаться теми же самыми, не пересоздаваться на каждый клик.
let cutMpvLoadedPath = null;
let cutMpvUnlisten = null;
// ResizeObserver, следящий за плейсхолдером видео — по спецификации при
// отключении/удалении наблюдаемого элемента он шлёт ЕЩЁ ОДИН callback с
// нулевым размером, а сам инстанс живёт, пока explicitly не
// .disconnect(). Без disconnect() каждая перерисовка плодила новый
// ResizeObserver поверх старых (подтверждено логами: mpv_create
// вызывался 2-3 раза на один openCutMpv и число росло за сессию).
let cutMpvResizeObserver = null;
// Обработчик resize окна вешается на window, а не на плейсхолдер, и
// потому НЕ умирает вместе с закрытой модалкой: раньше каждое открытие
// инструментов добавляло ещё один, навсегда удерживая ссылку на уже
// удалённый оверлей. Держим ссылку, чтобы снять при закрытии.
let cutMpvWindowResizeHandler = null;

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
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  const dpr = window.devicePixelRatio || 1;
  return {
    x: Math.round(r.left * dpr),
    y: Math.round(r.top * dpr),
    width: Math.round(r.width * dpr),
    height: Math.round(r.height * dpr),
  };
}

async function syncMpvBounds(root) {
  // Модалку могли уже закрыть — тогда двигать нечего, а не жаловаться
  // в лог на каждый тик ResizeObserver.
  if (!root.isConnected || cutMpvLoadedPath == null) return;
  const rect = videoSurfaceRect(root);
  if (!rect) return;
  try {
    await invoke("mpv_set_bounds", rect);
  } catch (e) {
    mpvLog.warn("mpv_set_bounds не прошёл", e);
  }
}

// Закрывает нативное окно/процесс mpv — обязательно перед сменой файла
// на аудио, переключением на другую операцию и закрытием модалки (любым
// способом, включая Escape и клик по фону): иначе процесс и нативное
// окно переживают закрытую панель и остаются висеть ПОВЕРХ интерфейса —
// чёрный прямоугольник с чужим видео на весь список отчётов.
async function closeCutMpv() {
  if (cutMpvUnlisten) { cutMpvUnlisten(); cutMpvUnlisten = null; }
  if (cutMpvResizeObserver) { cutMpvResizeObserver.disconnect(); cutMpvResizeObserver = null; }
  if (cutMpvWindowResizeHandler) {
    window.removeEventListener("resize", cutMpvWindowResizeHandler);
    cutMpvWindowResizeHandler = null;
  }
  cutMpvLoadedPath = null;
  try { await invoke("mpv_close"); } catch { /* не критично при закрытии */ }
}

async function openCutMpv(root) {
  const rect = videoSurfaceRect(root);
  if (!rect) { mpvLog.warn("плейсхолдер видео ещё не разложен — плеер не создаём"); return; }
  mpvLog.info("mpv_create", rect);
  try {
    await invoke("mpv_create", rect);
  } catch (e) {
    mpvLog.error("mpv_create failed", e);
    toast(`Не удалось открыть видео-плеер: ${e}`, "error");
    return;
  }
  if (cutState.path !== cutMpvLoadedPath) {
    cutMpvLoadedPath = cutState.path;
    try {
      await invoke("mpv_load", { path: cutState.path });
      await invoke("mpv_set_volume", { volume: cutState.volume });
      await invoke("mpv_set_mute", { mute: cutState.muted });
      await invoke("mpv_set_speed", { speed: cutState.speed });
      await invoke("mpv_play");
      cutState.mpvPaused = false;
    } catch (e) {
      mpvLog.error("mpv_load/mpv_play failed", e);
      toast(`Не удалось загрузить видео в плеер: ${e}`, "error");
    }
  }
  if (!cutMpvUnlisten) {
    cutMpvUnlisten = await listen("mpv-state", event => onMpvState(root, event.payload || {}));
  }
}

function onMpvState(root, { name, data }) {
  switch (name) {
    case "time-pos":
      if (typeof data === "number") {
        cutState.lastKnownTime = data;
        refreshCutPlayhead(root);
      }
      break;
    case "duration":
      if (typeof data === "number" && data > 0) {
        cutState.mpvDuration = data;
        refreshCutPlayhead(root);
      }
      break;
    case "pause":
      cutState.mpvPaused = !!data;
      updatePlayButton(root);
      break;
    case "eof-reached":
      if (data) { cutState.mpvPaused = true; updatePlayButton(root); }
      break;
    case "volume":
      if (typeof data === "number") cutState.volume = data;
      break;
    case "speed":
      if (typeof data === "number") cutState.speed = data;
      break;
    case "file-error":
      toast(`Плеер не смог открыть файл: ${data}`, "error");
      break;
    case "exited":
      // Бэкенд уже убрал своё состояние — следующий выбор файла поднимет
      // плеер заново, поэтому здесь только сбрасываем свою половину.
      cutMpvLoadedPath = null;
      cutState.mpvPaused = true;
      updatePlayButton(root);
      toast("Плеер mpv неожиданно завершился.", "error");
      break;
    default:
      break;
  }
}

function updatePlayButton(root) {
  const btn = root.querySelector("#mt-cut-playpause");
  if (btn) btn.textContent = cutState.mpvPaused ? "▶" : "⏸";
}

async function mpvTogglePlay(root) {
  cutState.mpvPaused = !cutState.mpvPaused;
  updatePlayButton(root);
  try {
    await invoke(cutState.mpvPaused ? "mpv_pause" : "mpv_play");
  } catch (e) {
    toast(`Плеер: ${e}`, "error");
  }
}

async function frameStep(root, forward) {
  // Покадровый шаг у mpv всегда ставит на паузу — отражаем это в кнопке,
  // иначе она врёт до следующего события.
  cutState.mpvPaused = true;
  updatePlayButton(root);
  try { await invoke("mpv_frame_step", { forward }); } catch (e) { toast(`Плеер: ${e}`, "error"); }
}

async function seekTo(root, seconds) {
  const clamped = Math.max(0, Math.min(cutDuration() || seconds, seconds));
  cutState.lastKnownTime = clamped;
  refreshCutPlayhead(root);
  if (isVideoFile()) {
    try { await invoke("mpv_seek", { seconds: clamped }); } catch (e) { toast(`Плеер: ${e}`, "error"); }
  } else {
    const media = root.querySelector("#mt-cut-audio");
    if (media) media.currentTime = clamped;
  }
}

const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

function playerBarHtml() {
  return `
    <div class="mt-player-bar">
      <button class="icon-btn" id="mt-cut-frame-back" title="Кадр назад (,)">⯇|</button>
      <button class="icon-btn mt-play" id="mt-cut-playpause" title="Play/pause (пробел)">${cutState.mpvPaused ? "▶" : "⏸"}</button>
      <button class="icon-btn" id="mt-cut-frame-fwd" title="Кадр вперёд (.)">|⯈</button>
      <span class="mt-time" id="mt-cut-time">0:00.0 / 0:00.0</span>
      <span class="mt-player-spacer"></span>
      <button class="icon-btn" id="mt-cut-mute" title="Без звука (m)">${cutState.muted ? "🔇" : "🔊"}</button>
      <input type="range" id="mt-cut-volume" class="mt-volume" min="0" max="130" step="1" value="${cutState.volume}" title="Громкость">
      <select id="mt-cut-speed" class="mt-speed" title="Скорость воспроизведения">
        ${SPEED_OPTIONS.map(v => `<option value="${v}" ${v === cutState.speed ? "selected" : ""}>${v}×</option>`).join("")}
      </select>
    </div>`;
}

function segmentListHtml() {
  if (!cutState.segments.length) {
    return `<div class="no-assignee">Пока нет сегментов — отметьте I/O и добавьте.</div>`;
  }
  const total = cutState.segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  return cutState.segments.map((s, i) => `
    <div class="mt-segment-row" data-i="${i}">
      <span>${i + 1}.</span>
      <span>${formatTimePrecise(s.start)} – ${formatTimePrecise(s.end)}</span>
      <span class="mt-segment-dur">(${formatTimePrecise(s.end - s.start)})</span>
      <button class="icon-btn" data-seek-segment="${i}" title="Перейти">▶</button>
      <button class="icon-btn" data-remove-segment="${i}" title="Удалить">✕</button>
    </div>`).join("")
    + `<div class="mt-info-line">Итого к экспорту: ${formatTimePrecise(total)}</div>`;
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
      ? `<div class="mt-video" id="mt-cut-video-surface"></div>${playerBarHtml()}`
      : `<audio id="mt-cut-audio" src="${esc(convertFileSrc(cutState.path))}" controls style="width:100%;"></audio>`}
    <canvas class="mt-timeline" id="mt-cut-timeline"></canvas>
    <div class="mt-io-row">
      <button class="btn" id="mt-mark-in">⏮ I — начало</button>
      <span id="mt-mark-in-val">—</span>
      <button class="btn" id="mt-mark-out">⏭ O — конец</button>
      <span id="mt-mark-out-val">—</span>
      <button class="btn primary" id="mt-add-segment">+ Добавить сегмент</button>
    </div>
    <div class="mt-segment-list" id="mt-segment-list"></div>
    <div class="mt-export-row">
      <label><input type="checkbox" id="mt-keep-separate" checked> Экспортировать сегменты отдельно</label>
      <label><input type="checkbox" id="mt-merge"> Склеить всё в один файл</label>
      <button class="btn primary" id="mt-cut-export">✂ Экспортировать</button>
    </div>
    <div class="mt-hotkeys">Пробел — play/pause · I / O — метки · , / . — кадр назад/вперёд · ← → — ±1 с (с Shift ±10 с) · Enter — добавить сегмент</div>
  `;
}

function drawCutTimeline(canvas) {
  if (!canvas) return;
  const duration = cutDuration();
  if (!duration) return;
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 560;
  const cssHeight = 56;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const trackTop = cssHeight / 2 - 3;
  ctx.fillStyle = "#251a20";
  ctx.fillRect(0, trackTop, cssWidth, 6);

  // Сегменты — заливка полосой во всю высоту.
  cutState.segments.forEach(s => {
    const x1 = (s.start / duration) * cssWidth;
    const x2 = (s.end / duration) * cssWidth;
    ctx.fillStyle = "rgba(255, 106, 77, .35)";
    ctx.fillRect(x1, 4, Math.max(1.5, x2 - x1), cssHeight - 20);
  });

  // Незакоммиченный интервал между метками — видно, что именно уедет в
  // сегмент, ещё до нажатия «Добавить».
  if (cutState.markIn != null && cutState.markOut != null) {
    const a = Math.min(cutState.markIn, cutState.markOut);
    const b = Math.max(cutState.markIn, cutState.markOut);
    ctx.fillStyle = "rgba(107, 198, 148, .18)";
    ctx.fillRect((a / duration) * cssWidth, 4, Math.max(1.5, ((b - a) / duration) * cssWidth), cssHeight - 20);
  }

  // Засечки опорных кадров — тонкие вертикальные штрихи. На длинном
  // видео их тысячи; рисуем не больше одной на пиксель, иначе нижняя
  // полоса превращается в сплошную заливку и перестаёт что-либо значить.
  ctx.strokeStyle = "rgba(255,255,255,.25)";
  ctx.lineWidth = 1;
  let lastX = -2;
  cutState.keyframes.forEach(k => {
    const x = Math.round((k / duration) * cssWidth);
    if (x - lastX < 2) return;
    lastX = x;
    ctx.beginPath();
    ctx.moveTo(x, cssHeight - 20);
    ctx.lineTo(x, cssHeight - 12);
    ctx.stroke();
  });

  // Шкала времени — раньше таймлайн был безразмерной полосой без единой
  // подписи, и понять, где на ней 3 минуты, было нельзя.
  const stepSec = niceTimeStep(duration, cssWidth);
  ctx.fillStyle = "rgba(255,255,255,.45)";
  ctx.font = "10px ui-monospace, monospace";
  ctx.textBaseline = "bottom";
  for (let t = 0; t <= duration; t += stepSec) {
    const x = (t / duration) * cssWidth;
    ctx.fillRect(x, cssHeight - 12, 1, 4);
    if (x < cssWidth - 28) ctx.fillText(formatTime(t), x + 2, cssHeight - 1);
  }

  const drawMark = (t, color) => {
    if (t == null) return;
    const x = (t / duration) * cssWidth;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, cssHeight - 12);
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
  ctx.lineTo(x, cssHeight - 12);
  ctx.stroke();
}

// Шаг подписей шкалы: круглое число, при котором подписи не сливаются
// (примерно одна на 70 пикселей).
function niceTimeStep(duration, width) {
  const target = duration / Math.max(1, Math.floor(width / 70));
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steps.find(s => s >= target) || 3600;
}

// Перерисовка только «живых» частей панели. Полный re-render (который
// был раньше на каждый клик) пересобирал и плейсхолдер видео — то есть
// на каждую метку I/O пересоздавалось нативное окно mpv, со всеми
// вытекающими: мигание картинки, лишние mpv_create, новый ResizeObserver.
function refreshCutPlayhead(root) {
  drawCutTimeline(root.querySelector("#mt-cut-timeline"));
  const timeEl = root.querySelector("#mt-cut-time");
  if (timeEl) {
    const audioEl = root.querySelector("#mt-cut-audio");
    const t = audioEl ? audioEl.currentTime : cutState.lastKnownTime;
    timeEl.textContent = `${formatTimePrecise(t)} / ${formatTimePrecise(cutDuration())}`;
  }
}

function refreshCutMarks(root) {
  const inEl = root.querySelector("#mt-mark-in-val");
  const outEl = root.querySelector("#mt-mark-out-val");
  if (inEl) inEl.textContent = cutState.markIn == null ? "—" : formatTimePrecise(cutState.markIn);
  if (outEl) outEl.textContent = cutState.markOut == null ? "—" : formatTimePrecise(cutState.markOut);
  const list = root.querySelector("#mt-segment-list");
  if (list) {
    list.innerHTML = segmentListHtml();
    wireSegmentRows(root);
  }
  const exportBtn = root.querySelector("#mt-cut-export");
  if (exportBtn) exportBtn.disabled = !cutState.segments.length || jobRunning;
  refreshCutPlayhead(root);
}

function wireSegmentRows(root) {
  root.querySelectorAll("[data-seek-segment]").forEach(btn => {
    btn.addEventListener("click", () => {
      const s = cutState.segments[Number(btn.dataset.seekSegment)];
      if (s) seekTo(root, s.start);
    });
  });
  root.querySelectorAll("[data-remove-segment]").forEach(btn => {
    btn.addEventListener("click", () => {
      cutState.segments.splice(Number(btn.dataset.removeSegment), 1);
      refreshCutMarks(root);
    });
  });
}

function currentPlayTime(root) {
  const audioEl = root.querySelector("#mt-cut-audio");
  return audioEl ? audioEl.currentTime : cutState.lastKnownTime;
}

function addSegment(root) {
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
  refreshCutMarks(root);
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
    cutState.mpvDuration = null;
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

  if (isVideoFile()) {
    openCutMpv(root);
    root.querySelector("#mt-cut-playpause").addEventListener("click", () => mpvTogglePlay(root));
    root.querySelector("#mt-cut-frame-back").addEventListener("click", () => frameStep(root, false));
    root.querySelector("#mt-cut-frame-fwd").addEventListener("click", () => frameStep(root, true));
    const volume = root.querySelector("#mt-cut-volume");
    volume.addEventListener("input", async () => {
      cutState.volume = Number(volume.value);
      try { await invoke("mpv_set_volume", { volume: cutState.volume }); } catch { /* плеер мог закрыться */ }
    });
    root.querySelector("#mt-cut-mute").addEventListener("click", async e => {
      cutState.muted = !cutState.muted;
      e.currentTarget.textContent = cutState.muted ? "🔇" : "🔊";
      try { await invoke("mpv_set_mute", { mute: cutState.muted }); } catch { /* плеер мог закрыться */ }
    });
    const speed = root.querySelector("#mt-cut-speed");
    speed.addEventListener("change", async () => {
      cutState.speed = Number(speed.value);
      try { await invoke("mpv_set_speed", { speed: cutState.speed }); } catch { /* плеер мог закрыться */ }
    });

    // Плейсхолдер пересобирается при полной перерисовке панели —
    // ResizeObserver навешиваем на новый узел, но СНАЧАЛА отключаем
    // предыдущий инстанс: сам он не исчезает и копится.
    if (cutMpvResizeObserver) { cutMpvResizeObserver.disconnect(); cutMpvResizeObserver = null; }
    const surface = root.querySelector("#mt-cut-video-surface");
    if (surface && typeof ResizeObserver !== "undefined") {
      cutMpvResizeObserver = new ResizeObserver(() => syncMpvBounds(root));
      cutMpvResizeObserver.observe(surface);
    }
    // resize окна — событие глобальное, на плейсхолдер его не повесить;
    // держим ссылку, чтобы снять обработчик в closeCutMpv (иначе каждое
    // открытие инструментов оставляло в window ещё один, навсегда
    // удерживая ссылку на уже удалённый оверлей).
    if (!cutMpvWindowResizeHandler) {
      cutMpvWindowResizeHandler = () => syncMpvBounds(root);
      window.addEventListener("resize", cutMpvWindowResizeHandler);
    }
  } else if (audioEl) {
    audioEl.addEventListener("timeupdate", () => refreshCutPlayhead(root));
    audioEl.addEventListener("loadedmetadata", () => refreshCutPlayhead(root));
    audioEl.volume = Math.min(1, cutState.volume / 100);
  }

  // Клик и перетаскивание по таймлайну — раньше работал только клик,
  // то есть «проскрести» до нужного места было нельзя.
  let scrubbing = false;
  const seekFromEvent = e => {
    const duration = cutDuration();
    if (!duration) return;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(root, frac * duration);
  };
  canvas.addEventListener("pointerdown", e => {
    scrubbing = true;
    canvas.setPointerCapture(e.pointerId);
    seekFromEvent(e);
  });
  canvas.addEventListener("pointermove", e => { if (scrubbing) seekFromEvent(e); });
  const stopScrub = e => {
    if (!scrubbing) return;
    scrubbing = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* указателя уже нет */ }
  };
  canvas.addEventListener("pointerup", stopScrub);
  canvas.addEventListener("pointercancel", stopScrub);

  root.querySelector("#mt-mark-in").addEventListener("click", () => {
    cutState.markIn = currentPlayTime(root);
    refreshCutMarks(root);
  });
  root.querySelector("#mt-mark-out").addEventListener("click", () => {
    cutState.markOut = currentPlayTime(root);
    refreshCutMarks(root);
  });
  root.querySelector("#mt-add-segment").addEventListener("click", () => addSegment(root));

  refreshCutMarks(root);

  root.querySelector("#mt-cut-export").addEventListener("click", async () => {
    const keepSeparate = root.querySelector("#mt-keep-separate").checked;
    const merge = root.querySelector("#mt-merge").checked;
    if (!keepSeparate && !merge) {
      toast("Выберите хотя бы один вариант экспорта.", "error");
      return;
    }
    const outDir = await pickOutputDir();
    if (!outDir) return;
    const btn = root.querySelector("#mt-cut-export");
    const result = await runJob(root, {
      button: btn,
      busyLabel: "Режу…",
      run: () => invoke("mt_cut_media", {
        path: cutState.path,
        segments: cutState.segments,
        outDir,
        keepSeparate,
        merge,
      }),
    });
    if (!result) return;
    const count = result.segmentPaths.length + (result.mergedPath ? 1 : 0);
    toastDone(`Готово: ${count} файл(ов).`, result.mergedPath || result.segmentPaths[0] || outDir);
  });
}

// Горячие клавиши панели «Обрезка» — вешаются на модалку один раз (см.
// openMediaTools), а не на каждый re-render. Игнорируем нажатия внутри
// полей ввода: там те же буквы — это просто текст.
function isTypingTarget(el) {
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

function handleCutHotkey(root, e) {
  if (activeOp !== "cut" || !cutState.path || isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  const step = e.shiftKey ? 10 : 1;
  // Раскладка: клавиша, а не символ — «i»/«ш» и «o»/«щ» это одна и та же
  // физическая клавиша, а в студии печатают по-русски.
  switch (e.code) {
    case "Space":
      e.preventDefault();
      if (isVideoFile()) mpvTogglePlay(root);
      else { const a = root.querySelector("#mt-cut-audio"); if (a) (a.paused ? a.play() : a.pause()); }
      break;
    case "KeyI":
      e.preventDefault();
      cutState.markIn = currentPlayTime(root);
      refreshCutMarks(root);
      break;
    case "KeyO":
      e.preventDefault();
      cutState.markOut = currentPlayTime(root);
      refreshCutMarks(root);
      break;
    case "KeyM":
      if (!isVideoFile()) break;
      e.preventDefault();
      root.querySelector("#mt-cut-mute")?.click();
      break;
    case "Comma":
      if (!isVideoFile()) break;
      e.preventDefault();
      frameStep(root, false);
      break;
    case "Period":
      if (!isVideoFile()) break;
      e.preventDefault();
      frameStep(root, true);
      break;
    case "ArrowLeft":
      e.preventDefault();
      seekTo(root, currentPlayTime(root) - step);
      break;
    case "ArrowRight":
      e.preventDefault();
      seekTo(root, currentPlayTime(root) + step);
      break;
    case "Enter":
      e.preventDefault();
      addSegment(root);
      break;
    default:
      break;
  }
}

// ============================================================
// Конвертация / транскод — см. transcode_media в media_tools.rs.
// ============================================================

const CONVERT_PRESETS = {
  mp4_h264: { label: "MP4 (H.264/AAC) — универсальный", container: "mp4", opts: { videoCodec: "libx264", audioCodec: "aac", crf: 23 } },
  telegram: { label: "Сжать для Telegram (720p, ~2 Мбит/с)", container: "mp4", opts: { videoCodec: "libx264", audioCodec: "aac", height: 720, videoBitrate: "2M", audioBitrate: "128k" } },
  webm_vp9: { label: "WebM (VP9/Opus)", container: "webm", opts: { videoCodec: "libvpx-vp9", audioCodec: "libopus", crf: 32 } },
  prores: { label: "ProRes 422 (монтажный мастер)", container: "mov", opts: { videoCodec: "prores_ks", audioCodec: "pcm_s16le" } },
  custom: { label: "Свои параметры", container: "mp4", opts: {} },
};

// Поля «своих параметров» переживают перерисовку панели — иначе смена
// пресета или добавление файла в пул стирали уже введённые значения.
const convertState = {
  poolIndex: null, path: null, info: null, preset: "mp4_h264",
  container: null,
  custom: { videoCodec: "", audioCodec: "", width: "", height: "", videoBitrate: "", audioBitrate: "", crf: "" },
};

const CONTAINERS = ["mp4", "mkv", "mov", "webm"];

function convertContainer() {
  return convertState.container || CONVERT_PRESETS[convertState.preset].container;
}

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
  const c = convertState.custom;
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
        <select id="mt-c-vcodec">
          ${[["", "не менять"], ["libx264", "H.264"], ["libx265", "H.265"], ["libvpx-vp9", "VP9"], ["prores_ks", "ProRes"]]
            .map(([v, l]) => `<option value="${v}" ${v === c.videoCodec ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </div>
      <div class="mt-form-row"><span>Аудио-кодек</span>
        <select id="mt-c-acodec">
          ${[["", "не менять"], ["aac", "AAC"], ["libopus", "Opus"], ["libmp3lame", "MP3"], ["flac", "FLAC"], ["pcm_s16le", "PCM 16 бит"]]
            .map(([v, l]) => `<option value="${v}" ${v === c.audioCodec ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </div>
      <div class="mt-form-row"><span>Ширина / высота (px)</span>
        <input id="mt-c-width" type="number" min="1" max="16384" placeholder="авто" style="width:90px;" value="${esc(c.width)}">
        <input id="mt-c-height" type="number" min="1" max="16384" placeholder="авто" style="width:90px;" value="${esc(c.height)}">
      </div>
      <div class="mt-form-row"><span>Битрейт видео / аудио</span>
        <input id="mt-c-vbitrate" type="text" placeholder="напр. 2M" style="width:90px;" value="${esc(c.videoBitrate)}">
        <input id="mt-c-abitrate" type="text" placeholder="напр. 128k" style="width:90px;" value="${esc(c.audioBitrate)}">
      </div>
      <div class="mt-form-row"><span>CRF (качество, меньше — лучше)</span>
        <input id="mt-c-crf" type="number" min="0" max="63" placeholder="напр. 23" style="width:90px;" value="${esc(c.crf)}">
      </div>
    </div>
    <div class="mt-form-row">
      <span>Контейнер результата</span>
      <select id="mt-convert-container">
        ${CONTAINERS.map(x => `<option value="${x}" ${x === convertContainer() ? "selected" : ""}>${x}</option>`).join("")}
      </select>
    </div>
    <button class="btn primary" id="mt-convert-run">🔄 Конвертировать</button>
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
    // Пресет задаёт свой контейнер — но только пока пользователь не
    // выбрал контейнер руками.
    convertState.container = null;
    renderActivePanel(root);
  });
  root.querySelector("#mt-convert-container").addEventListener("change", e => {
    convertState.container = e.target.value;
  });

  // Запоминаем ввод сразу, а не только в момент запуска: панель
  // перерисовывается при любых изменениях пула.
  const customFields = {
    videoCodec: "#mt-c-vcodec", audioCodec: "#mt-c-acodec",
    width: "#mt-c-width", height: "#mt-c-height",
    videoBitrate: "#mt-c-vbitrate", audioBitrate: "#mt-c-abitrate", crf: "#mt-c-crf",
  };
  Object.entries(customFields).forEach(([key, sel]) => {
    const el = root.querySelector(sel);
    if (el) el.addEventListener("input", () => { convertState.custom[key] = el.value; });
  });

  root.querySelector("#mt-convert-run").addEventListener("click", async () => {
    const c = convertState.custom;
    const opts = convertState.preset === "custom" ? {
      videoCodec: c.videoCodec || null,
      audioCodec: c.audioCodec || null,
      width: Number(c.width) || null,
      height: Number(c.height) || null,
      videoBitrate: c.videoBitrate.trim() || null,
      audioBitrate: c.audioBitrate.trim() || null,
      // Number(...)||null съедал бы CRF 0 (визуально «без потерь») —
      // проверяем именно на пустую строку.
      crf: c.crf === "" ? null : Number(c.crf),
    } : CONVERT_PRESETS[convertState.preset].opts;
    const container = convertContainer();
    const outPath = await pickOutputFile(`${stemOf(convertState.path)}.${container}`, [
      { name: container.toUpperCase(), extensions: [container] },
    ]);
    if (!outPath) return;

    const btn = root.querySelector("#mt-convert-run");
    const ok = await runJob(root, {
      button: btn,
      busyLabel: "Конвертирую…",
      run: async () => { await invoke("mt_transcode_media", { path: convertState.path, outPath, opts }); return true; },
    });
    if (ok) toastDone("Конвертация завершена.", outPath);
  });
}

// ============================================================
// Аудио — извлечь/конвертировать/нормализовать, см. extract_audio.
// ============================================================

const AUDIO_CODEC_EXT = { copy: null, aac: "m4a", libmp3lame: "mp3", flac: "flac", libopus: "opus", pcm_s16le: "wav" };
const audioState = { poolIndex: null, path: null, info: null, codec: "copy", bitrate: "", normalize: false };

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
        (EBU R128 loudnorm, два прохода — динамика дубля не меняется).</p>
      </div>`;
  }
  const codecs = [
    ["copy", "Как есть (без перекодирования)"],
    ["aac", "AAC (.m4a)"],
    ["libmp3lame", "MP3"],
    ["flac", "FLAC (без потерь)"],
    ["libopus", "Opus"],
    ["pcm_s16le", "WAV PCM 16 бит"],
  ];
  return `
    ${picker}
    <div class="mt-form-row">
      <span>Кодек</span>
      <select id="mt-audio-codec">
        ${codecs.map(([v, l]) => `<option value="${v}" ${v === audioState.codec ? "selected" : ""}>${l}</option>`).join("")}
      </select>
    </div>
    <div class="mt-form-row">
      <span>Битрейт</span>
      <input id="mt-audio-bitrate" type="text" placeholder="напр. 192k (пусто — по умолчанию)" style="width:200px;" value="${esc(audioState.bitrate)}">
    </div>
    <div class="mt-form-row">
      <label><input type="checkbox" id="mt-audio-normalize" ${audioState.normalize ? "checked" : ""}> Нормализовать громкость (loudnorm, −16 LUFS)</label>
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

  const codecSel = root.querySelector("#mt-audio-codec");
  const normalizeBox = root.querySelector("#mt-audio-normalize");
  const bitrateInput = root.querySelector("#mt-audio-bitrate");

  bitrateInput.addEventListener("input", () => { audioState.bitrate = bitrateInput.value; });
  // «Как есть» и нормализация несовместимы по определению (фильтр
  // требует декодирования). Раньше интерфейс говорил «переключаю на
  // AAC», но сам ничего не переключал — подмену делал молча бэкенд, и в
  // диалоге сохранения предлагалось не то расширение.
  const reconcile = () => {
    audioState.codec = codecSel.value;
    audioState.normalize = normalizeBox.checked;
    if (audioState.normalize && audioState.codec === "copy") {
      audioState.codec = "aac";
      codecSel.value = "aac";
      toast("«Как есть» несовместимо с нормализацией — переключил на AAC.");
    }
  };
  codecSel.addEventListener("change", reconcile);
  normalizeBox.addEventListener("change", reconcile);

  root.querySelector("#mt-audio-run").addEventListener("click", async () => {
    const codec = audioState.codec;
    const bitrate = audioState.bitrate.trim() || null;
    const normalize = audioState.normalize;
    const effectiveExt = AUDIO_CODEC_EXT[codec] || extOf(audioState.path) || "m4a";
    const outPath = await pickOutputFile(`${stemOf(audioState.path)}.${effectiveExt}`, [
      { name: effectiveExt.toUpperCase(), extensions: [effectiveExt] },
    ]);
    if (!outPath) return;

    const btn = root.querySelector("#mt-audio-run");
    const ok = await runJob(root, {
      button: btn,
      busyLabel: "Обрабатываю…",
      run: async () => { await invoke("mt_extract_audio", { path: audioState.path, outPath, opts: { codec, bitrate, normalize } }); return true; },
    });
    if (ok) toastDone("Готово.", outPath);
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
    const outPath = await pickOutputFile(`merged.${ext}`, [{ name: ext.toUpperCase(), extensions: [ext] }]);
    if (!outPath) return;
    const mode = await runJob(root, {
      button: runBtn,
      busyLabel: "Склеиваю…",
      run: () => invoke("mt_concat_media", { paths: concatState.paths, outPath }),
    });
    if (!mode) return;
    toastDone(
      mode === "copy"
        ? "Склеено без перекодирования (файлы совпадали по кодекам)."
        : "Склеено с перекодированием (кодеки/разрешение входов отличались).",
      outPath,
    );
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
    const outPath = await pickOutputFile("muxed.mkv", [{ name: "Matroska", extensions: ["mkv"] }]);
    if (!outPath) return;
    const ok = await runJob(root, {
      button: runBtn,
      busyLabel: "Муксирую…",
      run: async () => { await invoke("mt_mux_media", { tracks, outPath }); return true; },
    });
    if (ok) toastDone("Готово.", outPath);
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
    ${jobHtml()}
    <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
  `, "wide");

  // Закрытие модалки ЛЮБЫМ способом должно убирать нативное окно mpv.
  // Раньше это висело только на кнопке «Закрыть», а Escape и клик по
  // фону (см. dismissSheet в api.js) оставляли живой процесс и его
  // окно — чёрный прямоугольник с видео поверх всего интерфейса,
  // который уже ничем не убрать, кроме перезапуска приложения.
  const teardown = async () => {
    window.removeEventListener("keydown", hotkeys, true);
    await closeCutMpv();
  };
  const hotkeys = e => handleCutHotkey(overlay, e);
  window.addEventListener("keydown", hotkeys, true);
  overlay.addEventListener("sheet-dismissed", teardown);
  overlay.querySelector("[data-close]").addEventListener("click", async () => {
    await teardown();
    overlay.remove();
  });

  overlay.querySelectorAll(".mt-op-tab").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (jobRunning) { toast("Дождитесь окончания текущей операции.", "error"); return; }
      // Ушли с «Обрезки» — плейсхолдер видео исчез из DOM, нативное
      // окно/процесс mpv без него осиротели.
      if (activeOp === "cut" && btn.dataset.op !== "cut") await closeCutMpv();
      activeOp = btn.dataset.op;
      overlay.querySelectorAll(".mt-op-tab").forEach(b => b.classList.toggle("active", b === btn));
      renderActivePanel(overlay);
    });
  });
  renderPoolBar(overlay);
  renderActivePanel(overlay);
  return overlay;
}

$("#open-media-tools").addEventListener("click", openMediaTools);
