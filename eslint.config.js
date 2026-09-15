// Плоский конфиг ESLint (v9) для фронтенда — обычный vanilla JS без
// сборки, поэтому конфиг минимальный: браузерные глобалы + ES2022,
// без TypeScript/React-специфичных правил, которые тут не нужны.
module.exports = [
  {
    files: ["dist/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
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
      },
    },
    rules: {
      // `catch (_) {}` — идиома "намеренно проигнорированная ошибка",
      // используется по всему app.js (не критично для UI, тихо
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
];
