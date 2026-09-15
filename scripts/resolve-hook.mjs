// Loader-хук для verify-modules.mjs: резолвит бэйр-спецификаторы
// ("@tauri-apps/api/core" и т.п.) по тому же dist/importmap.json,
// что использует браузер — Node этот формат сам не понимает.

import { pathToFileURL } from "node:url";
import path from "node:path";

let importMap = null;
let distDir = null;

export function initialize(data) {
  importMap = data.importMap;
  distDir = data.distDir;
}

export async function resolve(specifier, context, nextResolve) {
  if (importMap && importMap.imports && importMap.imports[specifier]) {
    const target = path.join(distDir, importMap.imports[specifier]);
    return { url: pathToFileURL(target).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
