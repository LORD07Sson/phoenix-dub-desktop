// Общее изменяемое состояние приложения — один объект-синглтон,
// импортируется по ссылке во все модули (мутации видны всем сразу,
// как и раньше, когда всё было одним файлом с общей областью видимости).

export const state = {
  token: null,
  telegramId: null,
  name: null,
  mediaToken: null, // короткоживущий токен для <img src> — см. ensureMediaToken() в api.js
  mediaTokenExpiresAt: 0,
  reports: [],
  total: 0,
  sort: { field: "public_id", dir: "asc" },
  selected: new Set(), // public_id
  statusOptions: [
    ["draft", "Черновик"],
    ["working", "В работе"],
    ["review", "На проверке"],
    ["revision", "Требует исправления"],
    ["completed", "Завершено"],
    ["cancelled", "Отменено"],
  ],
  users: [],
  quickFilter: null, // null | "mine" | "overdue" | "unassigned"
  activeTab: "overview",
  loadedTabs: new Set(),
  titleSeasonId: null,
  isDeveloper: null, // null = ещё не запрашивали /api/me
};

// Выход из аккаунта. Раньше logout чистил только token и selected —
// loadedTabs оставался полным, а loadActiveTab() пропускает уже
// «загруженную» вкладку, поэтому следующий вошедший на этой машине
// видел в Списке/Доске/Ленте отчёты предыдущего, пока сам не нажмёт
// «Обновить». Всё, что относится к конкретному человеку, сбрасываем
// здесь одним местом (statusOptions/sort/activeTab — настройки самого
// интерфейса, они переживают смену пользователя).
export function resetSessionState() {
  state.token = null;
  state.telegramId = null;
  state.name = null;
  state.mediaToken = null;
  state.mediaTokenExpiresAt = 0;
  state.reports = [];
  state.total = 0;
  state.selected.clear();
  state.users = [];
  state.quickFilter = null;
  state.loadedTabs.clear();
  state.titleSeasonId = null;
  state.isDeveloper = null;
}
