//! Раскладка доски: сортировка, метрики колонок и поиск.
//!
//! Раньше вкладка «Доска» рисовала ровно то, что прислал сервер, в том
//! порядке, в каком оно пришло: карточки шли вперемешку, и чтобы понять,
//! что горит, доску приходилось читать глазами целиком. Здесь она
//! превращается из списка в раскладку — у каждой карточки считается
//! срочность, у каждой колонки метрики, и порядок появляется сам.
//!
//! Почему в Rust, а не в JS. Выигрыш тут не в скорости — на сотне
//! карточек разницы не будет, а IPC-переход её и вовсе съест. Выигрыш в
//! том, что это чистая функция: у неё есть ровно один вход, ровно один
//! выход и нет DOM, поэтому вся арифметика дат, порогов и весов
//! прогоняется юнит-тестами (ниже их дюжина), а не проверяется глазами
//! на живой доске. Раньше такой логики просто не существовало —
//! появляться ей сразу в обработчиках рендера означало бы появиться
//! непроверяемой.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

// ---------- даты без лишней зависимости ----------

/// Дней от 1970-01-01 до указанной даты по григорианскому календарю.
/// Алгоритм Говарда Хиннанта (days_from_civil) — тот же, что лежит в
/// основе `<chrono>` в C++20 и `time`/`chrono` в Rust; тянуть ради двух
/// вычитаний целый крейт незачем, а писать «примерно» нельзя: ошибка в
/// високосном году тихо сдвинет все дедлайны студии на сутки.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m + 9) % 12; // март = 0
    let doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// "YYYY-MM-DD" или "YYYY-MM-DD HH:MM:SS" — дата в днях от эпохи.
/// Всё, что не разбирается, даёт None: сервер может прислать пустую
/// строку или null, и это нормальная ситуация («без срока»), а не сбой.
fn parse_date(value: &str) -> Option<i64> {
    let date = value.get(..10)?;
    let mut parts = date.split('-');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let d: i64 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

// ---------- вход ----------

#[derive(Deserialize, Clone)]
pub struct BoardCard {
    pub public_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub deadline: Option<String>,
    /// Когда карточка последний раз менялась — из неё считается
    /// «сколько она уже лежит в этом статусе».
    #[serde(default)]
    pub updated_at: Option<String>,
    /// Когда отчёт создан — вместе с deadline даёт реальный (не
    /// выдуманный) диапазон дат для таймлайна на доске: «когда взяли»
    /// → «когда сдать». Прокидывается как есть, без вычислений здесь.
    #[serde(default)]
    pub created_at: Option<String>,
    /// Прокидывается обратно в неизменном виде: рисует его фронтенд,
    /// разбирать здесь нечего.
    #[serde(default)]
    pub assignees: serde_json::Value,
    /// Число вложений/заметок — тоже прокидывается как есть, посчитаны
    /// на сервере (см. _attach_counts в miniapp/server.py). Нужны для
    /// бейджей 📎N/💬N на карточке (перенос референса Xentra).
    #[serde(default)]
    pub files_count: u32,
    #[serde(default)]
    pub notes_count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardColumnIn {
    pub status: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub has_more: bool,
    #[serde(default)]
    pub reports: Vec<BoardCard>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardView {
    /// "smart" | "deadline" | "priority" | "age" | "none"
    #[serde(default)]
    pub sort: String,
    /// Поиск по номеру и названию, регистронезависимый.
    #[serde(default)]
    pub query: String,
    /// Сегодняшняя дата глазами клиента ("YYYY-MM-DD"): часовой пояс
    /// студии знает фронтенд, а не бэкенд, и «просрочено» должно
    /// считаться по местному календарю пользователя.
    #[serde(default)]
    pub today: String,
    /// Сколько карточек в колонке считается перебором. Ключ — статус.
    #[serde(default)]
    pub wip_limits: HashMap<String, u32>,
    /// Сколько дней без движения считать «залежалось».
    #[serde(default)]
    pub stale_after_days: i64,
}

// ---------- выход ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardCardOut {
    pub public_id: String,
    pub title: String,
    pub priority: Option<String>,
    pub deadline: Option<String>,
    pub created_at: Option<String>,
    pub assignees: serde_json::Value,
    /// Дней до срока: отрицательное — просрочено, None — срока нет.
    pub days_left: Option<i64>,
    pub overdue: bool,
    /// Дней без изменений.
    pub age_days: Option<i64>,
    pub stale: bool,
    pub unassigned: bool,
    /// 0..1 — насколько карточка «горит». Фронтенд рисует этим
    /// насыщенность полоски, а не придумывает свою шкалу.
    pub heat: f64,
    pub files_count: u32,
    pub notes_count: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardColumnOut {
    pub status: String,
    pub label: String,
    pub total: u32,
    pub has_more: bool,
    pub shown: u32,
    pub overdue: u32,
    pub unassigned: u32,
    pub stale: u32,
    pub avg_age_days: Option<i64>,
    /// Лимит по статусу и превышен ли он — «сколько работы взяли в
    /// параллель» это единственная метрика, ради которой канбан-доски
    /// вообще заводят.
    pub wip_limit: Option<u32>,
    pub over_wip: bool,
    pub cards: Vec<BoardCardOut>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardLayout {
    pub columns: Vec<BoardColumnOut>,
    /// Сколько карточек отсеял поиск — иначе пустая доска выглядит как
    /// сбой загрузки.
    pub filtered_out: u32,
    pub total_overdue: u32,
    pub total_stale: u32,
}

const PRIORITY_WEIGHT: &[(&str, f64)] = &[
    ("urgent", 1.0),
    ("high", 0.66),
    ("normal", 0.33),
    ("low", 0.0),
];

fn priority_weight(priority: Option<&str>) -> f64 {
    let p = priority.unwrap_or("normal");
    PRIORITY_WEIGHT
        .iter()
        .find(|(name, _)| *name == p)
        .map(|(_, w)| *w)
        .unwrap_or(0.33)
}

/// «Насколько горит» — одно число от 0 до 1, в которое сведены приоритет,
/// близость срока и застой. Им доска красит полоску карточки, и он же
/// второй ключ сортировки в режиме «умно».
///
/// Просрочка НЕ участвует здесь как «чем дольше, тем горячее»: день
/// просрочки и год просрочки требуют внимания одинаково — важно, что
/// срок уже прошёл. А то, что просроченное идёт выше непросроченного
/// при любых приоритетах, решается не весами, а отдельным ключом
/// сортировки (см. sort_cards): это разные категории работы, а не
/// разные значения одной шкалы, и смешивать их в одно число значит
/// рано или поздно подобрать веса так, что срочная задача «на
/// послезавтра» перекроет то, что горит уже неделю.
fn heat(days_left: Option<i64>, priority: Option<&str>, age_days: Option<i64>, stale_after: i64) -> f64 {
    let p = priority_weight(priority) * 0.4;
    let deadline = match days_left {
        // Просрочено — максимум и дальше не растёт: «просрочено на день»
        // и «просрочено на год» одинаково требуют внимания сейчас.
        Some(d) if d < 0 => 0.45,
        Some(d) => (0.45 * (1.0 - (d as f64 / 14.0)).clamp(0.0, 1.0)).max(0.0),
        None => 0.0,
    };
    let stale = match age_days {
        Some(a) if stale_after > 0 => (0.15 * (a as f64 / stale_after as f64)).clamp(0.0, 0.15),
        _ => 0.0,
    };
    (p + deadline + stale).clamp(0.0, 1.0)
}

fn is_unassigned(assignees: &serde_json::Value) -> bool {
    match assignees {
        serde_json::Value::Array(a) => a.is_empty(),
        serde_json::Value::Null => true,
        _ => false,
    }
}

fn matches_query(card: &BoardCard, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    card.public_id.to_lowercase().contains(needle) || card.title.to_lowercase().contains(needle)
}

/// Основная функция модуля. Чистая: ничего не читает из окружения (даже
/// сегодняшнюю дату — её передаёт фронтенд), поэтому целиком
/// воспроизводима в тестах.
pub fn layout(columns: Vec<BoardColumnIn>, view: &BoardView) -> BoardLayout {
    let today = parse_date(&view.today);
    let needle = view.query.trim().to_lowercase();
    let stale_after = if view.stale_after_days > 0 { view.stale_after_days } else { 7 };

    let mut filtered_out = 0u32;
    let mut total_overdue = 0u32;
    let mut total_stale = 0u32;
    let mut out_columns = Vec::with_capacity(columns.len());

    for col in columns {
        let mut cards = Vec::with_capacity(col.reports.len());
        let mut age_sum = 0i64;
        let mut age_count = 0i64;
        let (mut overdue_n, mut unassigned_n, mut stale_n) = (0u32, 0u32, 0u32);

        for card in col.reports {
            if !matches_query(&card, &needle) {
                filtered_out += 1;
                continue;
            }
            let days_left = match (today, card.deadline.as_deref().and_then(parse_date)) {
                (Some(t), Some(d)) => Some(d - t),
                _ => None,
            };
            let age_days = match (today, card.updated_at.as_deref().and_then(parse_date)) {
                (Some(t), Some(u)) => Some((t - u).max(0)),
                _ => None,
            };
            // Завершённое и отменённое не бывает «просроченным» — там
            // срок уже неважен, а красная метка только шумит.
            let terminal = matches!(col.status.as_str(), "completed" | "cancelled");
            let overdue = !terminal && days_left.map(|d| d < 0).unwrap_or(false);
            let stale = !terminal && age_days.map(|a| a >= stale_after).unwrap_or(false);
            let unassigned = is_unassigned(&card.assignees);

            if overdue { overdue_n += 1; total_overdue += 1; }
            if stale { stale_n += 1; total_stale += 1; }
            if unassigned { unassigned_n += 1; }
            if let Some(a) = age_days { age_sum += a; age_count += 1; }

            cards.push(BoardCardOut {
                public_id: card.public_id,
                title: card.title,
                heat: if terminal { 0.0 } else { heat(days_left, card.priority.as_deref(), age_days, stale_after) },
                priority: card.priority,
                deadline: card.deadline,
                created_at: card.created_at,
                assignees: card.assignees,
                days_left,
                overdue,
                age_days,
                stale,
                unassigned,
                files_count: card.files_count,
                notes_count: card.notes_count,
            });
        }

        sort_cards(&mut cards, &view.sort);

        let wip_limit = view.wip_limits.get(&col.status).copied();
        out_columns.push(BoardColumnOut {
            over_wip: wip_limit.map(|l| col.total > l).unwrap_or(false),
            wip_limit,
            status: col.status,
            label: col.label,
            total: col.total,
            has_more: col.has_more,
            shown: cards.len() as u32,
            overdue: overdue_n,
            unassigned: unassigned_n,
            stale: stale_n,
            avg_age_days: (age_count > 0).then(|| age_sum / age_count),
            cards,
        });
    }

    BoardLayout { columns: out_columns, filtered_out, total_overdue, total_stale }
}

fn sort_cards(cards: &mut [BoardCardOut], sort: &str) {
    match sort {
        // Порядок с сервера — «как было», на случай если кому-то из
        // студии привычнее именно он.
        "none" => {}
        "deadline" => cards.sort_by(|a, b| {
            // Без срока — в конец: иначе они занимают весь верх доски.
            let key = |c: &BoardCardOut| c.days_left.unwrap_or(i64::MAX);
            key(a).cmp(&key(b)).then_with(|| a.public_id.cmp(&b.public_id))
        }),
        "priority" => cards.sort_by(|a, b| {
            priority_weight(b.priority.as_deref())
                .partial_cmp(&priority_weight(a.priority.as_deref()))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.public_id.cmp(&b.public_id))
        }),
        "age" => cards.sort_by(|a, b| {
            let key = |c: &BoardCardOut| c.age_days.unwrap_or(-1);
            key(b).cmp(&key(a)).then_with(|| a.public_id.cmp(&b.public_id))
        }),
        // "smart" и всё незнакомое
        _ => cards.sort_by(|a, b| {
            // Сначала категория «уже просрочено» целиком, и только
            // внутри неё — по срочности. Иначе достаточно повесить на
            // задачу ярлык «срочно» со сроком «послезавтра», чтобы она
            // перекрыла то, что горит уже неделю.
            b.overdue
                .cmp(&a.overdue)
                .then_with(|| b.heat.partial_cmp(&a.heat).unwrap_or(std::cmp::Ordering::Equal))
                // При равной срочности — по номеру, чтобы порядок был
                // устойчивым между перерисовками и карточки не прыгали.
                .then_with(|| a.public_id.cmp(&b.public_id))
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(id: &str, priority: &str, deadline: Option<&str>, updated: Option<&str>, assigned: bool) -> BoardCard {
        BoardCard {
            public_id: id.into(),
            title: format!("Серия {id}"),
            priority: Some(priority.into()),
            deadline: deadline.map(str::to_string),
            updated_at: updated.map(str::to_string),
            created_at: None,
            assignees: if assigned {
                serde_json::json!([{ "telegram_id": 1, "name": "Кто-то" }])
            } else {
                serde_json::json!([])
            },
            files_count: 0,
            notes_count: 0,
        }
    }

    fn column(status: &str, cards: Vec<BoardCard>) -> BoardColumnIn {
        BoardColumnIn {
            status: status.into(),
            label: status.into(),
            total: cards.len() as u32,
            has_more: false,
            reports: cards,
        }
    }

    fn view(sort: &str) -> BoardView {
        BoardView {
            sort: sort.into(),
            query: String::new(),
            today: "2026-09-18".into(),
            wip_limits: HashMap::new(),
            stale_after_days: 7,
        }
    }

    // ---------- даты ----------

    #[test]
    fn days_from_civil_matches_known_reference_points() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
        assert_eq!(days_from_civil(2000, 3, 1), 11017);
        // 2000 — високосный (делится на 400), 1900 — нет (делится на 100).
        assert_eq!(days_from_civil(2000, 2, 29) + 1, days_from_civil(2000, 3, 1));
        assert_eq!(days_from_civil(1900, 2, 28) + 1, days_from_civil(1900, 3, 1));
        // Ровно год без високосного дня.
        assert_eq!(days_from_civil(2027, 1, 1) - days_from_civil(2026, 1, 1), 365);
    }

    #[test]
    fn parse_date_reads_both_shapes_and_refuses_junk() {
        assert_eq!(parse_date("2026-09-18"), Some(days_from_civil(2026, 9, 18)));
        // Сервер отдаёт время в том же поле — берём только дату.
        assert_eq!(parse_date("2026-09-18 14:31:02"), Some(days_from_civil(2026, 9, 18)));
        assert_eq!(parse_date(""), None);
        assert_eq!(parse_date("вчера"), None);
        assert_eq!(parse_date("2026-13-01"), None);
        assert_eq!(parse_date("2026-09-99"), None);
    }

    // ---------- срочность ----------

    #[test]
    fn overdue_is_its_own_tier_not_just_a_higher_score() {
        // Просроченная «обычная» идёт выше срочной со сроком завтра —
        // и это решает ключ сортировки, а не подбор весов: по одному
        // только heat срочная-на-завтра как раз выигрывает.
        let cols = vec![column("working", vec![
            card("R-URGENT", "urgent", Some("2026-09-19"), Some("2026-09-18"), true),
            card("R-LATE", "normal", Some("2026-09-10"), Some("2026-09-17"), true),
        ])];
        let out = layout(cols, &view("smart"));
        assert_eq!(out.columns[0].cards[0].public_id, "R-LATE");
        assert!(
            out.columns[0].cards[1].heat > out.columns[0].cards[0].heat,
            "по одной лишь шкале срочности победила бы срочная — именно поэтому нужен отдельный ключ"
        );
    }

    #[test]
    fn urgent_with_a_week_left_outranks_low_priority_with_the_same_week() {
        let urgent = heat(Some(7), Some("urgent"), Some(0), 7);
        let low = heat(Some(7), Some("low"), Some(0), 7);
        assert!(urgent > low);
    }

    #[test]
    fn heat_stays_in_range_and_never_exceeds_one() {
        let hottest = heat(Some(-100), Some("urgent"), Some(1000), 7);
        assert!((0.0..=1.0).contains(&hottest), "{hottest}");
        let coldest = heat(None, Some("low"), None, 7);
        assert!(coldest >= 0.0);
        // Просрочка на день и на год одинаково «горят»: важно, что срок
        // прошёл, а не насколько давно.
        assert_eq!(heat(Some(-1), Some("normal"), None, 7), heat(Some(-365), Some("normal"), None, 7));
    }

    // ---------- раскладка ----------

    #[test]
    fn smart_sort_puts_the_burning_card_first() {
        let cols = vec![column("working", vec![
            card("R-1", "low", Some("2026-12-01"), Some("2026-09-18"), true),
            card("R-2", "normal", Some("2026-09-10"), Some("2026-09-17"), true), // просрочено
            card("R-3", "urgent", Some("2026-09-19"), Some("2026-09-18"), true),
        ])];
        let out = layout(cols, &view("smart"));
        let order: Vec<&str> = out.columns[0].cards.iter().map(|c| c.public_id.as_str()).collect();
        assert_eq!(order[0], "R-2", "просроченная должна быть первой: {order:?}");
        assert_eq!(order[2], "R-1", "дальняя и низкоприоритетная — последней: {order:?}");
        assert_eq!(out.total_overdue, 1);
    }

    #[test]
    fn column_metrics_count_what_the_column_head_shows() {
        let cols = vec![column("working", vec![
            card("R-1", "normal", Some("2026-09-01"), Some("2026-09-01"), false), // просрочено, ничьё, залежалось
            card("R-2", "normal", Some("2026-10-01"), Some("2026-09-18"), true),
        ])];
        let out = layout(cols, &view("smart"));
        let c = &out.columns[0];
        assert_eq!(c.overdue, 1);
        assert_eq!(c.unassigned, 1);
        assert_eq!(c.stale, 1);
        assert_eq!(c.shown, 2);
        // Средний возраст: 17 дней и 0 дней.
        assert_eq!(c.avg_age_days, Some(8));
    }

    #[test]
    fn completed_column_is_never_overdue_or_stale() {
        // В «Завершено» карточка может лежать месяцами с давно прошедшим
        // сроком — это норма, а не пожар.
        let cols = vec![column("completed", vec![
            card("R-9", "urgent", Some("2020-01-01"), Some("2020-01-01"), true),
        ])];
        let out = layout(cols, &view("smart"));
        assert_eq!(out.columns[0].overdue, 0);
        assert_eq!(out.columns[0].stale, 0);
        assert_eq!(out.total_overdue, 0);
        assert_eq!(out.columns[0].cards[0].heat, 0.0);
    }

    #[test]
    fn search_filters_by_id_and_title_and_reports_how_many_it_hid() {
        let cols = vec![column("working", vec![
            card("R-1", "normal", None, None, true),
            card("R-2", "normal", None, None, true),
        ])];
        let mut v = view("smart");
        v.query = "  r-2 ".into();
        let out = layout(cols, &v);
        assert_eq!(out.columns[0].cards.len(), 1);
        assert_eq!(out.columns[0].cards[0].public_id, "R-2");
        assert_eq!(out.filtered_out, 1);
        // Счётчик колонки остаётся серверным (сколько всего в статусе),
        // а shown — сколько реально видно после фильтра.
        assert_eq!(out.columns[0].total, 2);
        assert_eq!(out.columns[0].shown, 1);
    }

    #[test]
    fn wip_limit_is_measured_against_the_whole_column_not_the_loaded_page() {
        // Колонка подгружается порциями: если считать по загруженным
        // карточкам, лимит «сработает» только после нажатия «показать
        // ещё», то есть никогда.
        let mut col = column("working", vec![card("R-1", "normal", None, None, true)]);
        col.total = 12;
        col.has_more = true;
        let mut v = view("smart");
        v.wip_limits.insert("working".into(), 5);
        let out = layout(vec![col], &v);
        assert_eq!(out.columns[0].wip_limit, Some(5));
        assert!(out.columns[0].over_wip);
    }

    #[test]
    fn explicit_sorts_do_what_they_say() {
        let cards = vec![
            card("R-1", "low", Some("2026-09-19"), Some("2026-09-01"), true),
            card("R-2", "urgent", Some("2026-12-31"), Some("2026-09-18"), true),
        ];
        let by_deadline = layout(vec![column("working", cards.clone())], &view("deadline"));
        assert_eq!(by_deadline.columns[0].cards[0].public_id, "R-1");

        let by_priority = layout(vec![column("working", cards.clone())], &view("priority"));
        assert_eq!(by_priority.columns[0].cards[0].public_id, "R-2");

        let by_age = layout(vec![column("working", cards.clone())], &view("age"));
        assert_eq!(by_age.columns[0].cards[0].public_id, "R-1", "самая давно не тронутая — первой");

        let untouched = layout(vec![column("working", cards)], &view("none"));
        assert_eq!(untouched.columns[0].cards[0].public_id, "R-1", "порядок сервера сохраняется");
    }

    #[test]
    fn cards_without_deadline_sink_instead_of_floating_to_the_top() {
        let cols = vec![column("working", vec![
            card("R-1", "normal", None, None, true),
            card("R-2", "normal", Some("2026-09-20"), None, true),
        ])];
        let out = layout(cols, &view("deadline"));
        assert_eq!(out.columns[0].cards[0].public_id, "R-2");
    }

    #[test]
    fn broken_today_disables_date_math_instead_of_lying() {
        // Если дату «сегодня» прислать не смогли, лучше показать доску
        // без отметок «просрочено», чем разметить всё наугад.
        let cols = vec![column("working", vec![
            card("R-1", "normal", Some("2020-01-01"), Some("2020-01-01"), true),
        ])];
        let mut v = view("smart");
        v.today = String::new();
        let out = layout(cols, &v);
        assert_eq!(out.columns[0].overdue, 0);
        assert_eq!(out.columns[0].cards[0].days_left, None);
        assert_eq!(out.columns[0].cards[0].age_days, None);
    }

    #[test]
    fn stable_order_for_equally_urgent_cards() {
        // Без вторичного ключа карточки с одинаковой срочностью
        // переставлялись бы между перерисовками — доска «дышала» бы на
        // каждое обновление.
        let cols = vec![column("working", vec![
            card("R-3", "normal", None, None, true),
            card("R-1", "normal", None, None, true),
            card("R-2", "normal", None, None, true),
        ])];
        let out = layout(cols, &view("smart"));
        let order: Vec<&str> = out.columns[0].cards.iter().map(|c| c.public_id.as_str()).collect();
        assert_eq!(order, ["R-1", "R-2", "R-3"]);
    }
}
