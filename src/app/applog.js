// Зеркалирует console.error/console.warn и необработанные JS-ошибки в
// файловые логи (tauri-plugin-log, см. src-tauri/src/main.rs::run()) —
// без переписывания каждого catch/toast() по всему проекту: весь
// существующий код продолжает звать обычный console.error, эта обёртка
// просто дублирует то же сообщение в файл, который можно прислать при
// жалобе, вместо пересказа "что-то не сработало" своими словами.
//
// Намеренно НЕ используем attachConsole() из @tauri-apps/plugin-log —
// он слушает событие "log://log" (то, что Rust сам пишет через
// TargetKind::Webview) и печатает его в консоль тем же console.*, что
// мы здесь патчим: подписавшись на него, мы бы зациклили лог сами на
// себя (JS -> Rust -> событие обратно в JS -> наш патч -> снова в Rust).
import { debug as logDebug, error as logError, info as logInfo, warn as logWarn } from "@tauri-apps/plugin-log";

function describe(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "object" && value !== null) {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

// Логгер с тегом модуля ("[mpv]", "[settings]" и т.п.) — виден и в
// devtools-консоли, и (в отличие от голого console.log/debug, которые
// installFileLogging() не трогает) в файловом логе на info/debug-
// уровне. warn/error можно звать и просто через console.warn/error —
// их уже мирроит installFileLogging(); эти два метода здесь — просто
// чтобы у вызывающего кода был единый API с префиксом темы.
export function tagLogger(tag) {
  const prefix = `[${tag}]`;
  return {
    debug: (...args) => { console.debug(prefix, ...args); logDebug(`${prefix} ${args.map(describe).join(" ")}`).catch(() => {}); },
    info: (...args) => { console.log(prefix, ...args); logInfo(`${prefix} ${args.map(describe).join(" ")}`).catch(() => {}); },
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
  };
}

export function installFileLogging() {
  const origError = console.error.bind(console);
  console.error = (...args) => {
    origError(...args);
    logError(args.map(describe).join(" ")).catch(() => { /* лог — best effort */ });
  };

  const origWarn = console.warn.bind(console);
  console.warn = (...args) => {
    origWarn(...args);
    logWarn(args.map(describe).join(" ")).catch(() => {});
  };

  // console.error/warn покрывают то, что код сам явно залогировал —
  // а необработанное исключение/отказ промиса иначе прошли бы мимо.
  window.addEventListener("error", event => {
    logError(`Необработанная ошибка: ${event.message} (${event.filename}:${event.lineno}:${event.colno})`).catch(() => {});
  });
  window.addEventListener("unhandledrejection", event => {
    logError(`Необработанный отказ промиса: ${describe(event.reason)}`).catch(() => {});
  });
}
