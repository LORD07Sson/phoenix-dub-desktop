// Плоский конфиг ESLint (v9) для фронтенда — минимальный: браузерные
// глобалы + ES2022 + JSX (для Overview.jsx на SolidJS — см. историю
// миграции, остальные вкладки пока на vanilla JS). .cjs, а не .js —
// package.json теперь несёт "type": "module" (нужно Vite-конфигу),
// а этот файл сам написан в CommonJS (module.exports).
module.exports = [
  {
    // Плоский конфиг ESLint 9 линтует ВСЕ .js в дереве, а не только
    // описанные ниже — без этого `npm run lint` после сборки падал на
    // сгенерированных ассетах в src-tauri/target/ и на собранном dist/.
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/target/**",
      "src-tauri/gen/**",
      "legacy_python_client/**",
    ],
  },
  {
    // src/app/*.js(x) — наш код, ES-модули (import/export). src/vendor/
    // больше нет — vendored-копии npm-пакетов Tauri заменены реальными
    // зависимостями (см. package.json), их резолвит и бандлит Vite.
    files: ["src/app/**/*.js", "src/app/**/*.jsx"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
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
        cancelAnimationFrame: "readonly",
        getComputedStyle: "readonly",
        Audio: "readonly",
        Blob: "readonly",
        URLSearchParams: "readonly",
        Promise: "readonly",
        Image: "readonly",
        confirm: "readonly",
        prompt: "readonly",
        MutationObserver: "readonly",
        ResizeObserver: "readonly",
        CustomEvent: "readonly",
        AbortController: "readonly",
        // pin-window.js — читает ?id= из адреса открепленного окна и
        // подменяет его на лету (PIN_REPORT_EVENT), не перезагружая
        // страницу.
        location: "readonly",
        history: "readonly",
        URL: "readonly",
        // Подставляется Vite на этапе сборки (define в vite.config.js).
        __APP_VERSION__: "readonly",
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
        // board-gestures-test.mjs сам кладёт jsdom-овский document в
        // globalThis (иначе бандл его не увидит) и дальше обращается к
        // нему по имени.
        document: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_$" }],
      "no-undef": "error",
    },
  },
];
