// Общее изменяемое состояние приложения — один объект-синглтон,
// импортируется по ссылке во все модули (мутации видны всем сразу,
// как и раньше, когда всё было одним файлом с общей областью видимости).

export const state = {
  token: null,
  telegramId: null,
  name: null,
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
