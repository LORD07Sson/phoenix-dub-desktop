// Донат-чарт (SVG, с анимацией заливки) — переиспользуется в Обзоре,
// профиле и карточке коллеги.

import { esc } from "./utils.js";

export function donutHtml(segments, size, thickness) {
  size = size || 120;
  thickness = thickness || 16;
  const r = (size - thickness) / 2;
  const circumference = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + x.count, 0);
  const cx = size / 2, cy = size / 2;
  let offsetAcc = 0;
  const circles = segments.filter(s => s.count > 0).map(s => {
    const frac = total ? s.count / total : 0;
    const len = frac * circumference;
    const dasharray = `${len} ${circumference - len}`;
    const dashoffset = -offsetAcc;
    offsetAcc += len;
    return `<circle class="donut-seg" cx="${cx}" cy="${cy}" r="${r}" fill="none"
      stroke="var(${s.colorVar})" stroke-width="${thickness}"
      stroke-dasharray="${circumference} ${circumference}"
      stroke-dashoffset="${circumference}"
      data-target-dasharray="${dasharray}" data-target-dashoffset="${dashoffset}"
      transform="rotate(-90 ${cx} ${cy})"></circle>`;
  }).join("");
  return `
    <svg class="donut-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="${thickness}"></circle>
      ${circles}
      <text x="${cx}" y="${cy - 3}" text-anchor="middle" font-size="20" font-weight="700" fill="var(--ink)">${total}</text>
      <text x="${cx}" y="${cy + 15}" text-anchor="middle" font-size="10" fill="var(--ink-dim)">всего</text>
    </svg>`;
}

// Заставляет только что вставленные .donut-seg проиграть анимацию
// заливки — без этого браузер применил бы target-значения мгновенно
// (переход же должен идти от "пусто" к заполненному состоянию).
export function playDonutIntro(root) {
  const segs = root.querySelectorAll(".donut-seg");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      segs.forEach(c => {
        c.setAttribute("stroke-dasharray", c.dataset.targetDasharray);
        c.setAttribute("stroke-dashoffset", c.dataset.targetDashoffset);
      });
    });
  });
}

export function donutLegendHtml(segments) {
  const total = segments.reduce((s, x) => s + x.count, 0);
  return segments.filter(s => s.count > 0).map(s => `
    <div class="donut-legend-item">
      <span class="dot" style="background:var(${s.colorVar})"></span>
      <span class="name">${esc(s.label)}</span>
      <span class="count">${s.count}${total ? ` · ${Math.round(s.count / total * 100)}%` : ""}</span>
    </div>
  `).join("") || `<div class="no-assignee">Пока нет данных</div>`;
}

// Сегментированный прогресс-бар с легендой (Обзор, KPI-плитка «Всего
// активных») — тот же набор segments, что уже идёт в donutHtml/
// donutLegendHtml выше, но в виде одной горизонтальной полосы, разбитой
// на цветные доли, плюс бейджи с количеством над ней и легенда под ней
// без цифр (сами цифры уже в бейджах). Перенесено вживую с референса
// пользователя (Dribbble: Xentra Digital Marketing Dashboard,
// dribbble.com/shots/27265906) — там карточка «Projects Performance»
// устроена именно так: большое число, бейджи "+N total" над полосой,
// сама полоса, цветные точки-подписи под ней.
export function segmentedBarHtml(segments) {
  const total = segments.reduce((s, x) => s + x.count, 0);
  const items = segments.filter(s => s.count > 0).map(s => {
    const pct = total ? (s.count / total * 100) : 0;
    return `<div class="seg-bar-item" style="background:var(${s.colorVar})" data-target-width="${pct}"></div>`;
  }).join("");
  return `<div class="seg-bar">${items}</div>`;
}

// Проигрывает заливку .seg-bar-item — тот же двух-кадровый
// requestAnimationFrame приём, что playDonutIntro/playRingIntro выше
// (без него браузер применил бы целевую ширину сразу, без перехода).
export function playSegBarIntro(root) {
  const items = root.querySelectorAll(".seg-bar-item");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      items.forEach(el => { el.style.width = `${el.dataset.targetWidth}%`; });
    });
  });
}

export function segBadgesHtml(segments) {
  return segments.filter(s => s.count > 0).map(s => `
    <span class="seg-badge" style="color:var(${s.colorVar})">
      <span class="dot" style="background:var(${s.colorVar})"></span>${s.count}
    </span>
  `).join("");
}

// Дельта-бейдж «+8%» / «-12%» рядом с заголовком KPI-плитки — тоже
// перенесено вживую с референса (Xentra: у каждой из четырёх карточек
// в шапке — число, цветная пилюля с процентом и подпись "From Last
// Month"). У нас такой подписи по месяцам нет, считаем по тому же
// 14-дневному тренду, что уже используется под «Всего активных»
// (сравниваем вторую половину окна с первой) — тот же принцип, другое
// окно, а не выдуманное число.
export function deltaPillHtml(pct) {
  if (pct === null || pct === undefined) return "";
  const positive = pct >= 0;
  return `<span class="delta-pill ${positive ? "up" : "down"}">${positive ? "+" : ""}${pct}%</span>`;
}

export function segLegendHtml(segments) {
  return segments.filter(s => s.count > 0).map(s => `
    <div class="seg-legend-item">
      <span class="dot" style="background:var(${s.colorVar})"></span>
      <span class="name">${esc(s.label)}</span>
    </div>
  `).join("") || `<div class="no-assignee">Пока нет данных</div>`;
}

// Мини-спарклайн под KPI-числом (Обзор) — компактная area+line без осей/
// подписей, только форма тренда. Та же идея, что donutHtml: строим SVG
// строкой, без сторонних chart-библиотек — конверсия нескольких точек
// в путь тривиальна, а либа только раздула бы бандл ради одного графика.
export function sparklineHtml(values, opts) {
  const w = (opts && opts.width) || 100;
  const h = (opts && opts.height) || 30;
  const colorVar = (opts && opts.colorVar) || "--fire";
  if (!values || values.length < 2) return "";
  const max = Math.max(...values);
  const min = Math.min(0, ...values);
  const range = Math.max(1, max - min);
  const stepX = w / (values.length - 1);
  const pts = values.map((v, i) => [i * stepX, h - ((v - min) / range) * h]);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  return `
    <svg class="sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <path class="sparkline-area" d="${area}" fill="var(${colorVar})"></path>
      <path class="sparkline-line" d="${line}" fill="none" stroke="var(${colorVar})"></path>
    </svg>`;
}

// Кольцо прогресса для KPI-плитки (доля от целого, 0..1) — тот же приём
// анимированной заливки по stroke-dasharray, что у donutHtml/goal-ring
// в profile.js, но с одним сегментом и подписью процента в центре.
export function kpiRingHtml(frac, opts) {
  const size = (opts && opts.size) || 56;
  const thickness = (opts && opts.thickness) || 6;
  const colorVar = (opts && opts.colorVar) || "--fire";
  const r = (size - thickness) / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, frac || 0));
  const dash = clamped * circumference;
  const cx = size / 2, cy = size / 2;
  return `
    <svg class="kpi-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle class="kpi-ring-track" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="${thickness}"></circle>
      <circle class="kpi-ring-fill" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(${colorVar})" stroke-width="${thickness}"
        stroke-linecap="round"
        stroke-dasharray="${circumference} ${circumference}" stroke-dashoffset="${circumference}"
        data-target-dashoffset="${circumference - dash}"
        transform="rotate(-90 ${cx} ${cy})"></circle>
    </svg>`;
}

// Проигрывает заливку .kpi-ring-fill, вставленных в root — тот же
// двух-кадровый requestAnimationFrame трюк, что и у playDonutIntro
// (иначе браузер применит целевой dashoffset без перехода).
export function playRingIntro(root) {
  const rings = root.querySelectorAll(".kpi-ring-fill");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      rings.forEach(c => c.setAttribute("stroke-dashoffset", c.dataset.targetDashoffset));
    });
  });
}
