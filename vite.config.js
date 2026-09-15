import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Единственный источник версии — файл VERSION в корне (в CI альфа-сборка
// подменяет её переменной PKG_VERSION, где к тому же номеру дописан
// "-alpha.N+sha"). Раньше номер жил ещё и литералом в src/app/settings.js,
// который CI правил sed'ом по исходнику — в git он от VERSION отставал.
const appVersion = (process.env.PKG_VERSION
  || readFileSync(new URL("./VERSION", import.meta.url), "utf8")).trim();

// dist/ теперь СБОРКА (Vite), а не исходники — исходники переехали в
// src/ (см. коммит "chore: dist/ -> src/, Vite + SolidJS"). frontendDist
// в tauri.conf.json остался "../dist" без изменений — путь тот же,
// просто раньше туда лежали руками написанные файлы, теперь их кладёт
// vite build.
export default defineConfig({
  root: "src",
  base: "./",
  plugins: [solid()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  // Tauri сам поднимает окно на frontendDist/devUrl — сервер разработки
  // не должен занимать порт, который уже используется чем-то другим
  // в системе (см. tauri.conf.json: build.devUrl).
  server: {
    port: 1420,
    strictPort: true,
  },
});
