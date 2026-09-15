// Плоский конфиг ESLint (v9) для фронтенда — обычный vanilla JS без
// сборки, поэтому конфиг минимальный: браузерные глобалы + ES2022,
// без TypeScript/React-специфичных правил, которые тут не нужны.
module.exports = [
  {
    // dist/app/*.js — наш код, ES-модули (import/export). dist/vendor/**
    // намеренно исключён ниже — сторонние файлы из npm-пакетов Tauri,
    // копируются как есть (см. dist/vendor/README.md), не наш стиль
    // проверять/чинить.
    files: ["dist/app/**/*.js"],
    ignores: ["dist/vendor/**"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        console: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        requestAnimationFrame: "readonly",
        URLSearchParams: "readonly",
        Promise: "readonly",
        Image: "readonly",
        confirm: "readonly",
        prompt: "readonly",
        MutationObserver: "readonly",
        CustomEvent: "readonly",
        AbortController: "readonly",
      },
    },
    rules: {
      // `catch (_) {}` — идиома "намеренно проигнорированная ошибка",
      // используется по всему коду (не критично для UI, тихо
      // продолжаем) — не варнинг, а осознанный выбор.
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_$", caughtErrorsIgnorePattern: "^_$" }],
      "no-undef": "error",
      "no-redeclare": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-unreachable": "error",
      "no-const-assign": "error",
      "no-debugger": "error",
      eqeqeq: ["warn", "smart"],
    },
  },
  {
    // Разовые Node-скрипты для ручной/CI-проверки графа ES-модулей
    // (scripts/verify-modules.mjs и его loader-хук) — не часть
    // рантайма приложения, свои (Node, не браузерные) глобалы.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        globalThis: "readonly",
        setTimeout: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_$" }],
      "no-undef": "error",
    },
  },
];
