import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// dist/ теперь СБОРКА (Vite), а не исходники — исходники переехали в
// src/ (см. коммит "chore: dist/ -> src/, Vite + SolidJS"). frontendDist
// в tauri.conf.json остался "../dist" без изменений — путь тот же,
// просто раньше туда лежали руками написанные файлы, теперь их кладёт
// vite build.
export default defineConfig({
  root: "src",
  base: "./",
  plugins: [solid()],
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
