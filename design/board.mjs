/**
 * Corridor — portal design board.
 *
 * Emits ONE svg holding every portal from plan.md on a single page, laid out
 * the way a Figma page is: labelled frames on a dark canvas. Driver is drawn in
 * phone chrome, every other portal in laptop chrome.
 *
 * The svg is written so `File > Import` (or drag-and-drop) into Figma yields a
 * clean layer tree: every <g> carries an id, which Figma uses as the layer name,
 * and every font resolves to a family Figma ships (Inter / Roboto Mono).
 *
 *   node design/board.mjs
 */
import { writeFileSync } from 'node:fs'

/* ---------- tokens (src/styles.css) ---------- */

const C = {
  canvas: '#06080b',
  bg: '#0b0e13',
  panel: '#141a24',
  panel2: '#1b2331',
  line: '#293343',
  text: '#e6ebf2',
  muted: '#8b97a8',
  dim: '#5a6577',
  faint: '#3a4354',
  accent: '#4ea3ff',
  ok: '#3ddc97',
  warn: '#ffb020',
  crit: '#ff6b5e',
  land: '#111823',
  water: '#0a1119',
  road: '#2b3444',
}

const SANS = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
const MONO = "Roboto Mono, ui-monospace, SFMono-Regular, Menlo, monospace"

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const r = (n) => Math.round(n * 100) / 100

/* ---------- emitter ---------- */

const out = []
const push = (s) => out.push(s)

function g(name, fn) {
  push(`<g id="${esc(name)}">`)
  fn()
  push('</g>')
}

function rect(x, y, w, h, o = {}) {
  const a = [`x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}"`]
  if (o.rx != null) a.push(`rx="${r(o.rx)}"`)
  a.push(`fill="${o.fill ?? 'none'}"`)
  if (o.stroke) a.push(`stroke="${o.stroke}" stroke-width="${o.sw ?? 1}"`)
  if (o.opacity != null) a.push(`opacity="${o.opacity}"`)
  push(`<rect ${a.join(' ')}/>`)
}

function circle(cx, cy, rad, fill, o = {}) {
  const a = [`cx="${r(cx)}" cy="${r(cy)}" r="${r(rad)}" fill="${fill ?? 'none'}"`]
  if (o.stroke) a.push(`stroke="${o.stroke}" stroke-width="${o.sw ?? 1}"`)
  if (o.opacity != null) a.push(`opacity="${o.opacity}"`)
  push(`<circle ${a.join(' ')}/>`)
}

function path(d, o = {}) {
  const a = [`d="${d}"`, `fill="${o.fill ?? 'none'}"`]
  if (o.stroke) a.push(`stroke="${o.stroke}" stroke-width="${o.sw ?? 1}"`)
  if (o.cap) a.push(`stroke-linecap="${o.cap}"`)
  if (o.join) a.push(`stroke-linejoin="${o.join}"`)
  if (o.dash) a.push(`stroke-dasharray="${o.dash}"`)
  if (o.opacity != null) a.push(`opacity="${o.opacity}"`)
  push(`<path ${a.join(' ')}/>`)
}

function line(x1, y1, x2, y2, stroke, o = {}) {
  const a = [`x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}"`]
  a.push(`stroke="${stroke}" stroke-width="${o.sw ?? 1}"`)
  if (o.dash) a.push(`stroke-dasharray="${o.dash}"`)
  if (o.opacity != null) a.push(`opacity="${o.opacity}"`)
  if (o.cap) a.push(`stroke-linecap="${o.cap}"`)
  push(`<line ${a.join(' ')}/>`)
}

/** y is the text baseline. */
function t(x, y, str, o = {}) {
  const a = [`x="${r(x)}" y="${r(y)}"`]
  a.push(`font-family="${o.mono ? MONO : SANS}"`)
  a.push(`font-size="${o.size ?? 13}"`)
  a.push(`fill="${o.fill ?? C.text}"`)
  if (o.weight) a.push(`font-weight="${o.weight}"`)
  if (o.anchor) a.push(`text-anchor="${o.anchor}"`)
  if (o.ls != null) a.push(`letter-spacing="${o.ls}"`)
  if (o.opacity != null) a.push(`opacity="${o.opacity}"`)
  push(`<text ${a.join(' ')}>${esc(str)}</text>`)
}

/** Rough advance width — good enough to size pills and align runs of text. */
const tw = (str, size, o = {}) =>
  String(str).length * size * (o.mono ? 0.6 : o.weight >= 600 ? 0.575 : 0.545) +
  (o.ls ?? 0) * String(str).length

/* ---------- ui primitives ---------- */

function panel(x, y, w, h, o = {}) {
  rect(x, y, w, h, {
    rx: o.rx ?? 10,
    fill: o.fill ?? C.panel,
    stroke: o.stroke ?? C.line,
    sw: 1,
  })
  if (o.accent) rect(x, y, 3, h, { rx: 1.5, fill: o.accent })
  let cy = y
  if (o.title) {
    t(x + 14, y + 22, o.title, {
      size: 10.5,
      weight: 700,
      ls: 1.3,
      fill: o.titleFill ?? C.muted,
    })
    if (o.aside)
      t(x + w - 14, y + 22, o.aside, {
        size: 10.5,
        weight: 600,
        ls: 0.6,
        fill: o.asideFill ?? C.dim,
        anchor: 'end',
        mono: true,
      })
    cy = y + 34
  }
  return cy
}

function divider(x, y, w, o = {}) {
  line(x, y, x + w, y, o.stroke ?? C.line, { opacity: o.opacity ?? 1 })
}

function bar(x, y, w, h, pct, color, o = {}) {
  rect(x, y, w, h, { rx: h / 2, fill: o.track ?? '#202938' })
  const fw = Math.max(h, (w * Math.min(1, Math.max(0, pct))))
  rect(x, y, fw, h, { rx: h / 2, fill: color })
}

function pill(x, y, label, o = {}) {
  const size = o.size ?? 10
  const padX = o.padX ?? 8
  const h = o.h ?? 20
  const w = o.w ?? tw(label, size, { weight: 700, ls: o.ls ?? 0.7 }) + padX * 2
  rect(x, y, w, h, {
    rx: o.rx ?? h / 2,
    fill: o.fill ?? 'none',
    stroke: o.stroke,
    sw: 1,
  })
  t(x + w / 2, y + h / 2 + size * 0.36, label, {
    size,
    weight: o.weight ?? 700,
    ls: o.ls ?? 0.7,
    fill: o.color ?? C.muted,
    anchor: 'middle',
    mono: o.mono,
  })
  return w
}

function btn(x, y, w, h, label, o = {}) {
  const kind = o.kind ?? 'ghost'
  const map = {
    primary: { fill: C.accent, color: '#05121f', stroke: null },
    ok: { fill: C.ok, color: '#052014', stroke: null },
    danger: { fill: C.crit, color: '#2a0705', stroke: null },
    warn: { fill: C.warn, color: '#241700', stroke: null },
    ghost: { fill: 'none', color: C.muted, stroke: C.line },
    ghostText: { fill: 'none', color: C.text, stroke: C.line },
  }
  const s = map[kind] ?? map.ghost
  rect(x, y, w, h, { rx: o.rx ?? 8, fill: s.fill, stroke: s.stroke, sw: 1 })
  t(x + w / 2, y + h / 2 + (o.size ?? 13) * 0.36, label, {
    size: o.size ?? 13,
    weight: o.weight ?? 600,
    fill: s.color,
    anchor: 'middle',
  })
}

/** label left / value right, on one baseline. */
function kv(x, y, w, label, value, o = {}) {
  t(x, y, label, { size: o.size ?? 12, fill: o.labelFill ?? C.muted })
  t(x + w, y, value, {
    size: o.size ?? 12,
    fill: o.valueFill ?? C.text,
    weight: o.weight ?? 500,
    anchor: 'end',
    mono: o.mono ?? true,
  })
}

function statTile(x, y, w, h, label, value, o = {}) {
  if (o.box !== false)
    rect(x, y, w, h, { rx: 8, fill: C.panel2, stroke: C.line, sw: 1 })
  const px = o.box === false ? x : x + 12
  t(px, y + 19, label, { size: 9.5, weight: 700, ls: 1.1, fill: C.muted })
  t(px, y + 44, value, {
    size: o.size ?? 21,
    weight: 700,
    fill: o.color ?? C.text,
    mono: o.mono ?? true,
    ls: -0.3,
  })
  if (o.sub) t(px, y + 61, o.sub, { size: 10.5, fill: o.subColor ?? C.dim })
  if (o.trend)
    t(px + tw(value, o.size ?? 21, { mono: true, weight: 700 }) + 8, y + 44, o.trend, {
      size: 13,
      fill: o.trendColor ?? C.ok,
      weight: 700,
    })
}

/** A chevron pointing along `dir` (1 east / -1 west) — the fleet marker. */
function truckMark(x, y, dir, color, o = {}) {
  const s = o.s ?? 5
  const d = dir >= 0
    ? `M ${r(x - s)} ${r(y - s)} L ${r(x + s * 1.3)} ${r(y)} L ${r(x - s)} ${r(y + s)} Z`
    : `M ${r(x + s)} ${r(y - s)} L ${r(x - s * 1.3)} ${r(y)} L ${r(x + s)} ${r(y + s)} Z`
  path(d, { fill: color, opacity: o.opacity ?? 1 })
}

/* ---------- device chrome ---------- */

const PHONE = { w: 390, h: 844, bez: 13 }
const LAPTOP = { w: 1440, h: 900, bx: 26, bt: 26, bb: 48 }

function phone(x, y, name, draw) {
  const { w, h, bez } = PHONE
  g(name, () => {
    rect(x - 1, y - 1, w + bez * 2 + 2, h + bez * 2 + 2, {
      rx: 58, fill: 'none', stroke: '#242b38', sw: 2,
    })
    rect(x, y, w + bez * 2, h + bez * 2, { rx: 57, fill: '#04060a' })
    rect(x + bez, y + bez, w, h, { rx: 45, fill: C.bg })
    g(`${name} / screen`, () => draw(x + bez, y + bez, w, h))
    rect(x + bez + w / 2 - 55, y + bez + 11, 110, 31, { rx: 15.5, fill: '#04060a' })
    circle(x + bez + w / 2 + 34, y + bez + 26.5, 4.5, '#131a24')
    rect(x + bez + w / 2 - 67, y + bez + h - 13, 134, 5, { rx: 2.5, fill: '#596373' })
  })
}

function laptop(x, y, name, draw) {
  const { w, h, bx, bt, bb } = LAPTOP
  const bw = w + bx * 2
  const bh = h + bt + bb
  g(name, () => {
    rect(x, y, bw, bh, { rx: 22, fill: '#0d1015', stroke: '#242b38', sw: 2 })
    rect(x + bx, y + bt, w, h, { rx: 5, fill: C.bg })
    g(`${name} / screen`, () => draw(x + bx, y + bt, w, h))
    circle(x + bw / 2, y + bt / 2, 3, '#1c2330')
    t(x + bw / 2, y + bt + h + 30, 'GLADIOLUS', {
      size: 11, ls: 3, weight: 700, fill: '#333c4c', anchor: 'middle',
    })
    rect(x - 92, y + bh + 2, bw + 184, 15, { rx: 7, fill: '#10141a', stroke: '#232a36', sw: 1 })
    rect(x + bw / 2 - 62, y + bh + 2, 124, 6, { rx: 3, fill: '#1b2331' })
  })
}

/** Figma-style frame caption sitting above a device. */
function caption(x, y, num, title, question, spec) {
  g(`caption / ${title}`, () => {
    t(x, y, num, { size: 22, weight: 700, fill: C.accent, mono: true, ls: -0.5 })
    const nx = x + tw(num, 22, { mono: true, weight: 700 }) + 14
    t(nx, y, title, { size: 22, weight: 700, fill: C.text, ls: -0.2 })
    const qx = nx + tw(title, 22, { weight: 700 }) + 16
    t(qx, y, question, { size: 16, weight: 400, fill: C.muted })
    t(x, y + 22, spec, { size: 11.5, fill: C.faint, mono: true, ls: 0.4 })
  })
}

/* ---------- shared app chrome ---------- */

function phoneStatusBar(x, y, w, time = '13:05') {
  t(x + 28, y + 33, time, { size: 13.5, weight: 700, fill: C.text, mono: true })
  const rx = x + w - 26
  for (let i = 0; i < 4; i++)
    rect(rx - 72 + i * 5, y + 26 - i * 2.2, 3.2, 7 + i * 2.2, { rx: 1, fill: C.text })
  path(
    `M ${r(rx - 44)} ${r(y + 30)} q 6 -8 12 0 M ${r(rx - 40)} ${r(y + 26)} q 8 -9 16 0`,
    { stroke: C.text, sw: 1.8, cap: 'round' },
  )
  rect(rx - 22, y + 21, 20, 10, { rx: 3, fill: 'none', stroke: C.text, sw: 1, opacity: 0.5 })
  rect(rx - 20.5, y + 22.5, 14, 7, { rx: 1.5, fill: C.text })
}

function phoneTabBar(x, y, w, active) {
  const tabs = ['Today', 'Log', 'Parking', 'Me']
  const h = 62
  rect(x, y, w, h, { fill: C.panel })
  divider(x, y, w)
  tabs.forEach((label, i) => {
    const cx = x + (w / 4) * (i + 0.5)
    const on = label === active
    const col = on ? C.accent : C.dim
    // glyph
    if (i === 0) rect(cx - 8, y + 15, 16, 13, { rx: 3, fill: 'none', stroke: col, sw: 1.6 })
    if (i === 1) {
      for (let k = 0; k < 3; k++)
        line(cx - 8, y + 17 + k * 5, cx + 8, y + 17 + k * 5, col, { sw: 1.6, cap: 'round' })
    }
    if (i === 2) {
      circle(cx, y + 21.5, 7.5, 'none', { stroke: col, sw: 1.6 })
      t(cx, y + 26, 'P', { size: 10, weight: 700, fill: col, anchor: 'middle' })
    }
    if (i === 3) {
      circle(cx, y + 18.5, 4.2, 'none', { stroke: col, sw: 1.6 })
      path(`M ${r(cx - 7)} ${r(y + 29)} q 7 -7 14 0`, { stroke: col, sw: 1.6, cap: 'round' })
    }
    t(cx, y + 45, label, { size: 10, weight: on ? 700 : 500, fill: col, anchor: 'middle' })
  })
}

function phoneHeader(x, y, w, unit, plate, driver, initials) {
  const h = 58
  rect(x, y, w, h, { fill: C.panel })
  divider(x, y + h, w)
  t(x + 18, y + 26, unit, { size: 17, weight: 700, fill: C.text, ls: -0.2 })
  t(x + 18, y + 43, plate, { size: 11, fill: C.dim, mono: true })
  circle(x + w - 34, y + h / 2, 15, C.panel2, { stroke: C.line })
  t(x + w - 34, y + h / 2 + 4.5, initials, { size: 11.5, weight: 700, fill: C.accent, anchor: 'middle' })
  t(x + w - 56, y + h / 2 + 4.5, driver, { size: 12.5, fill: C.muted, anchor: 'end' })
}

/** State strip under the phone header — the one line that says what is true. */
function stateStrip(x, y, w, color, label, detail) {
  const h = 30
  rect(x, y, w, h, { fill: color, opacity: 0.1 })
  line(x, y + h, x + w, y + h, color, { opacity: 0.35 })
  circle(x + 20, y + h / 2, 3.5, color)
  t(x + 32, y + h / 2 + 4, label, { size: 11, weight: 700, ls: 0.9, fill: color })
  t(x + w - 18, y + h / 2 + 4, detail, { size: 11, fill: C.muted, anchor: 'end', mono: true })
}

/** The four HOS clocks, as rows with bars. */
function hosRows(x, y, w, rows, o = {}) {
  const step = o.step ?? 34
  rows.forEach((row, i) => {
    const ry = y + i * step
    t(x, ry, row.label, { size: 11.5, fill: C.muted })
    t(x + w, ry, row.value, {
      size: 12, mono: true, weight: 600, anchor: 'end', fill: row.color ?? C.text,
    })
    bar(x, ry + 7, w, 4, row.pct, row.color ?? C.ok)
  })
  return y + rows.length * step
}

/** ELD duty log as a readable 24 h day. */
function dutyStrip(x, y, w, segs, o = {}) {
  const h = o.h ?? 26
  const key = { off: '#2a3342', sleeper: '#3a4a63', driving: C.accent, duty: C.warn }
  rect(x, y, w, h, { rx: 4, fill: '#161d28' })
  let cx = x
  segs.forEach((s) => {
    const sw = (s.hours / 24) * w
    rect(cx, y, sw, h, { fill: key[s.k] ?? C.line })
    cx += sw
  })
  rect(x, y, w, h, { rx: 4, fill: 'none', stroke: C.line, sw: 1 })
  for (let hr = 0; hr <= 24; hr += 6) {
    const tx = x + (hr / 24) * w
    line(tx, y + h, tx, y + h + 4, C.line)
    t(tx, y + h + 15, String(hr).padStart(2, '0'), {
      size: 9, fill: C.faint, mono: true, anchor: hr === 0 ? 'start' : hr === 24 ? 'end' : 'middle',
    })
  }
  if (o.now != null) {
    const nx = x + (o.now / 24) * w
    line(nx, y - 3, nx, y + h + 3, C.crit, { sw: 1.5 })
    circle(nx, y - 5, 2.5, C.crit)
  }
  return y + h + 20
}

/* ---------- laptop app chrome ---------- */

function topBar(x, y, w, active, o = {}) {
  const h = 52
  rect(x, y, w, h, { fill: C.panel })
  divider(x, y + h, w)
  t(x + 22, y + 32, 'Gladiolus', { size: 15, weight: 700, fill: C.text })
  t(x + 22 + tw('Gladiolus ', 15, { weight: 700 }), y + 32, 'Corridor', {
    size: 15, weight: 700, fill: C.accent,
  })
  const nav = ['Dispatch', 'Driver', 'System', 'Admin']
  let nx = x + 190
  nav.forEach((n) => {
    const bw = tw(n, 13, { weight: 500 }) + 24
    const on = n === active
    if (on) rect(nx, y + 12, bw, 28, { rx: 6, fill: C.panel2, stroke: C.line })
    t(nx + bw / 2, y + 30, n, {
      size: 13, weight: on ? 600 : 500, fill: on ? C.text : C.muted, anchor: 'middle',
    })
    nx += bw + 4
  })
  const right = x + w - 22
  circle(right - 14, y + 26, 14, C.panel2, { stroke: C.line })
  t(right - 14, y + 30.5, o.initials ?? 'AD', {
    size: 11, weight: 700, fill: C.accent, anchor: 'middle',
  })
  t(right - 40, y + 30, o.who ?? 'Dispatch · Kwame O.', {
    size: 11.5, fill: C.muted, anchor: 'end',
  })
  const clock = o.clock ?? '13:05:22'
  t(right - 40 - tw(o.who ?? 'Dispatch · Kwame O.', 11.5) - 22, y + 30, clock, {
    size: 12.5, fill: C.text, mono: true, anchor: 'end', weight: 500,
  })
  const sx = right - 40 - tw(o.who ?? 'Dispatch · Kwame O.', 11.5) - 22 - tw(clock, 12.5, { mono: true }) - 18
  t(sx, y + 30, o.seed ?? 'seed 20260906-A', {
    size: 11, fill: C.faint, mono: true, anchor: 'end',
  })
  return y + h + 1
}

/** Segmented control — [Road | Satellite] and friends. */
function segWidth(opts, o = {}) {
  const size = o.size ?? 11.5
  return opts.reduce((a, s) => a + tw(s, size, { weight: 600 }) + (o.padX ?? 22), 0) + 6
}

function segmented(x, y, opts, activeIdx, o = {}) {
  const h = o.h ?? 26
  const size = o.size ?? 11.5
  const widths = opts.map((s) => tw(s, size, { weight: 600 }) + (o.padX ?? 22))
  const w = widths.reduce((a, b) => a + b, 0) + 6
  rect(x, y, w, h, { rx: 7, fill: C.bg, stroke: C.line, sw: 1 })
  let cx = x + 3
  opts.forEach((s, i) => {
    const on = i === activeIdx
    if (on) rect(cx, y + 3, widths[i], h - 6, { rx: 5, fill: C.panel2, stroke: C.accent, sw: 1 })
    t(cx + widths[i] / 2, y + h / 2 + size * 0.36, s, {
      size, weight: on ? 700 : 500, fill: on ? C.text : C.muted, anchor: 'middle',
    })
    cx += widths[i]
  })
  return w
}

/* ---------- the corridor map (src/data/corridor.js, real coordinates) ---------- */

const CORRIDOR_POINTS = [
  [42.3149, -83.0364], [42.2559, -82.4363], [42.4048, -82.191], [42.4383, -81.8836],
  [42.6221, -81.6134], [42.9339, -81.2497], [43.0392, -80.8828], [43.1301, -80.746],
  [43.2557, -80.4507], [43.3616, -80.3144], [43.4668, -79.9899], [43.589, -79.6441],
  [43.7615, -79.5108], [43.777, -79.345],
]

const MAP_SITES = [
  { n: 'Windsor Cross-Dock', c: [42.3072, -83.0181], k: 'stop', lab: 'Windsor', side: 1 },
  { n: 'Chatham Produce', c: [42.4102, -82.1875], k: 'stop', lab: 'Chatham', side: 1 },
  { n: 'ONroute West Lorne', c: [42.6258, -81.6021], k: 'park', lab: '', side: -1 },
  { n: 'London DC', c: [42.9481, -81.2312], k: 'stop', lab: 'London DC', side: -1 },
  { n: 'Woodstock Assembly', c: [43.1418, -80.7331], k: 'stop', lab: 'Woodstock', side: 1 },
  { n: 'ONroute Cambridge N', c: [43.3661, -80.3011], k: 'park', lab: '', side: -1 },
  { n: 'Cambridge DC', c: [43.3701, -80.3022], k: 'stop', lab: 'Cambridge', side: 1 },
  { n: 'ONroute Trafalgar', c: [43.4712, -79.9741], k: 'park', lab: 'Trafalgar 94%', side: -1 },
  { n: 'Milton Intermodal', c: [43.4731, -79.9772], k: 'stop', lab: '', side: 1 },
  { n: 'Mississauga DC', c: [43.5951, -79.6382], k: 'stop', lab: '', side: 1 },
  { n: 'Scarborough Term.', c: [43.7801, -79.3388], k: 'stop', lab: 'Scarborough', side: -1 },
]

const LAKE_ERIE = [
  [42.02, -83.2], [42.06, -82.55], [42.2, -82.0], [42.5, -81.35],
  [42.72, -80.6], [42.86, -80.05], [42.88, -79.55], [42.0, -79.4],
]
const LAKE_ONTARIO = [
  [43.28, -79.82], [43.33, -79.72], [43.45, -79.5], [43.62, -79.2],
  [43.9, -78.6], [43.95, -78.2], [43.0, -78.2], [43.0, -79.9],
]

/** Fit the whole corridor into the map rect, with a margin. */
function makeProjector(x, y, w, h, m = 46) {
  const lats = CORRIDOR_POINTS.map((p) => p[0])
  const lons = CORRIDOR_POINTS.map((p) => p[1])
  const [la0, la1] = [Math.min(...lats) - 0.12, Math.max(...lats) + 0.1]
  const [lo0, lo1] = [Math.min(...lons) - 0.12, Math.max(...lons) + 0.12]
  const sx = (w - m * 2) / (lo1 - lo0)
  const sy = (h - m * 2) / (la1 - la0)
  const s = Math.min(sx, sy * 0.72)
  const ox = x + m + ((w - m * 2) - (lo1 - lo0) * s) / 2
  const oy = y + h - m - ((h - m * 2) - (la1 - la0) * s * 1.38) / 2
  return (lat, lon, clamp = true) => {
    let px = ox + (lon - lo0) * s
    let py = oy - (lat - la0) * s * 1.38
    if (clamp) {
      px = Math.min(x + w - 1, Math.max(x + 1, px))
      py = Math.min(y + h - 1, Math.max(y + 1, py))
    }
    return [px, py]
  }
}

const poly = (pts) => pts.map(([a, b], i) => `${i ? 'L' : 'M'} ${r(a)} ${r(b)}`).join(' ')

/**
 * opts: { satellite, breadcrumbs, selected, incident, label }
 * The satellite variant is the brief's named requirement, so it is drawn as a
 * distinct treatment rather than a checkbox nobody can see the effect of.
 */
function corridorMap(x, y, w, h, opts = {}) {
  const P = makeProjector(x, y, w, h, opts.compact ? 12 : 46)
  const sat = !!opts.satellite
  const line401 = CORRIDOR_POINTS.map(([a, b]) => P(a, b))

  rect(x, y, w, h, { fill: sat ? '#171512' : C.land })

  if (sat) {
    // Imagery: farmland blocks, woodland masses, urban grey — Southern Ontario
    // from 30 km up, abstracted. Enough to prove the toggle changes the world.
    const blobs = [
      [0.06, 0.62, 0.2, 0.2, '#2b2a1c'], [0.2, 0.5, 0.16, 0.24, '#232616'],
      [0.3, 0.72, 0.22, 0.2, '#2f2b1d'], [0.44, 0.42, 0.18, 0.22, '#25281a'],
      [0.55, 0.62, 0.2, 0.2, '#2c2a1d'], [0.66, 0.34, 0.16, 0.2, '#222519'],
      [0.76, 0.5, 0.18, 0.22, '#2e2c1e'], [0.12, 0.3, 0.18, 0.18, '#252718'],
      [0.4, 0.2, 0.2, 0.18, '#2a2a1c'], [0.62, 0.16, 0.18, 0.16, '#23261a'],
      [0.84, 0.2, 0.16, 0.22, '#33312a'], [0.88, 0.44, 0.12, 0.2, '#3a3830'],
    ]
    blobs.forEach(([bx, by, bw, bh, f], i) => {
      rect(x + bx * w, y + by * h, bw * w, bh * h, { fill: f, opacity: 0.95 })
      if (i % 3 === 0)
        rect(x + bx * w + 6, y + by * h + 6, bw * w * 0.5, bh * h * 0.4, {
          fill: '#3c3a26', opacity: 0.5,
        })
    })
    // field seams
    for (let i = 0; i < 26; i++)
      line(x + (i / 26) * w, y, x + (i / 26) * w + 30, y + h, '#000', { sw: 1, opacity: 0.16 })
  } else {
    // vector base: minor roads
    for (let i = 1; i < 9; i++)
      line(x, y + (i / 9) * h, x + w, y + (i / 9) * h - 28, C.road, { sw: 1, opacity: 0.28 })
    for (let i = 1; i < 14; i++)
      line(x + (i / 14) * w, y, x + (i / 14) * w - 20, y + h, C.road, { sw: 1, opacity: 0.2 })
  }

  const water = sat ? '#12222e' : C.water
  path(poly(LAKE_ERIE.map(([a, b]) => P(a, b))) + ' Z', { fill: water })
  path(poly(LAKE_ONTARIO.map(([a, b]) => P(a, b))) + ' Z', { fill: water })
  if (!opts.compact) {
    t(...P(42.28, -81.5), 'LAKE ERIE', {
      size: 10, ls: 2.4, fill: sat ? '#3f6b86' : '#22344a', weight: 600, anchor: 'middle',
    })
    t(...P(43.2, -79.3), 'LAKE ONTARIO', {
      size: 10, ls: 2.4, fill: sat ? '#3f6b86' : '#22344a', weight: 600, anchor: 'middle',
    })
  }

  // Highway 401
  path(poly(line401), { stroke: sat ? '#0a0d12' : '#0b0e13', sw: 7, cap: 'round', join: 'round' })
  path(poly(line401), { stroke: C.accent, sw: 3, cap: 'round', join: 'round', opacity: 0.95 })

  // breadcrumb history for the selected unit
  if (opts.breadcrumbs) {
    for (let i = 0; i < 26; i++) {
      const f = 0.18 + (i / 26) * 0.42
      const [px, py] = lerpAlong(line401, f)
      circle(px, py, 2.2, C.ok, { opacity: 0.28 + (i / 26) * 0.55 })
    }
  }

  // sites
  MAP_SITES.forEach((s) => {
    const [px, py] = P(...s.c)
    if (s.k === 'stop') {
      const r2 = opts.compact ? 3 : 4.5
      rect(px - r2, py - r2, r2 * 2, r2 * 2, { rx: 1.5, fill: C.panel, stroke: C.text, sw: 1.2 })
    } else if (!opts.compact) {
      circle(px + 9, py + 9, 4.5, C.panel, { stroke: C.warn, sw: 1.4 })
    }
    if (s.lab && !opts.compact)
      t(px, py + (s.side > 0 ? -11 : 24), s.lab, {
        size: 10.5, fill: sat ? '#e8e2d4' : C.muted, weight: 600, anchor: 'middle',
      })
  })

  // fleet
  const fleet = opts.compact ? [] : [
    0.04, 0.09, 0.14, 0.19, 0.24, 0.3, 0.35, 0.4, 0.45, 0.5,
    0.55, 0.6, 0.65, 0.7, 0.74, 0.79, 0.84, 0.89, 0.94,
  ]
  fleet.forEach((f, i) => {
    const [px, py] = lerpAlong(line401, f)
    const dir = i % 3 === 0 ? -1 : 1
    const col = i === 5 ? C.warn : i === 13 ? C.crit : C.ok
    truckMark(px, py + (dir > 0 ? -7 : 7), dir, col, { s: 4.6, opacity: 0.92 })
  })

  if (opts.selected) {
    const [px, py] = lerpAlong(line401, opts.selected)
    circle(px, py, opts.compact ? 11 : 15, C.accent, { opacity: 0.14 })
    circle(px, py, opts.compact ? 7 : 9, 'none', { stroke: C.accent, sw: 1.6 })
    truckMark(px, py, 1, C.accent, { s: opts.compact ? 4.2 : 5.4 })
    if (!opts.compact) {
      t(px + 16, py - 8, 'GLD-118', { size: 11, weight: 700, fill: C.text, mono: true })
      t(px + 16, py + 5, '97 km/h · 218 km to Milton', { size: 10, fill: C.muted })
    }
  }

  if (opts.incident) {
    const [px, py] = lerpAlong(line401, opts.incident)
    circle(px, py, 18, C.crit, { opacity: 0.18 })
    path(`M ${r(px)} ${r(py - 10)} L ${r(px + 10)} ${r(py + 7)} L ${r(px - 10)} ${r(py + 7)} Z`, {
      fill: C.crit,
    })
    t(px, py + 5, '!', { size: 12, weight: 700, fill: '#2a0705', anchor: 'middle' })
    t(px, py - 18, 'CLOSURE · 401 EB', { size: 10.5, weight: 700, fill: C.crit, anchor: 'middle', ls: 0.6 })
  }

  rect(x, y, w, h, { fill: 'none', stroke: C.line, sw: 1 })

  // scale bar + attribution, bottom-left
  if (!opts.compact) {
    line(x + 18, y + h - 20, x + 88, y + h - 20, sat ? '#e8e2d4' : C.muted, { sw: 2 })
    t(x + 18, y + h - 26, '50 km', { size: 9.5, fill: sat ? '#e8e2d4' : C.muted, mono: true })
    t(x + 18, y + h - 8, sat ? 'Esri World Imagery' : 'CartoDB dark · OSM', {
      size: 9, fill: sat ? '#a89f8b' : C.faint,
    })
  }
}

/** Point at fraction f along a polyline. */
function lerpAlong(pts, f) {
  const segs = []
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    segs.push(d)
    total += d
  }
  let want = f * total
  for (let i = 0; i < segs.length; i++) {
    if (want <= segs[i]) {
      const k = segs[i] === 0 ? 0 : want / segs[i]
      return [
        pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k,
        pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k,
      ]
    }
    want -= segs[i]
  }
  return pts[pts.length - 1]
}

/* ================= 01 · DRIVER — "what do I do right now?" ================= */

const HOS_FULL = [
  { label: 'Driving', value: '4:20 / 13:00', pct: 0.33, color: C.ok },
  { label: 'On duty', value: '12:15 / 14:00', pct: 0.875, color: C.warn },
  { label: 'Elapsed since rest', value: '12:15 / 16:00', pct: 0.766, color: C.warn },
  { label: 'Cycle 1', value: '48:00 / 70:00', pct: 0.686, color: C.ok },
]

const DUTY_DAY = [
  { k: 'off', hours: 5.5 }, { k: 'duty', hours: 0.6 }, { k: 'driving', hours: 2.4 },
  { k: 'duty', hours: 1.1 }, { k: 'driving', hours: 1.9 }, { k: 'off', hours: 0.6 },
  { k: 'driving', hours: 0.9 }, { k: 'duty', hours: 0.6 }, { k: 'off', hours: 10.4 },
]

function dutyLegend(x, y) {
  const items = [['driving', C.accent, 'Driving'], ['duty', C.warn, 'On duty'], ['off', '#2a3342', 'Off']]
  let cx = x
  items.forEach(([, col, label]) => {
    rect(cx, y - 7, 9, 9, { rx: 2, fill: col })
    t(cx + 13, y, label, { size: 10, fill: C.muted })
    cx += 13 + tw(label, 10) + 14
  })
}

/** 2x2 compact clocks, for the states where HOS is not the lead. */
function hosGrid(x, y, w, rows) {
  const cw = (w - 14) / 2
  rows.forEach((row, i) => {
    const cx = x + (i % 2) * (cw + 14)
    const cy = y + Math.floor(i / 2) * 42
    t(cx, cy, row.label, { size: 10, fill: C.muted, ls: 0.3 })
    t(cx + cw, cy, row.value, {
      size: 11.5, mono: true, weight: 600, anchor: 'end', fill: row.color,
    })
    bar(cx, cy + 7, cw, 3.5, row.pct, row.color)
  })
}

/** One-line, four-clock strip for the state where parking leads. */
function hosMini(x, y, w, rows) {
  const cw = w / 4
  rows.forEach((row, i) => {
    const cx = x + i * cw
    t(cx, y, row.short, { size: 9.5, weight: 700, ls: 0.9, fill: C.muted })
    t(cx, y + 17, row.mini, { size: 13, mono: true, weight: 700, fill: row.color })
    bar(cx, y + 25, cw - 12, 3.5, row.pct, row.color)
  })
}

function driverA(x, y, w) {
  phoneStatusBar(x, y, w, '13:05')
  phoneHeader(x, y + 46, w, 'GLD-118', 'ON BJ 4821 · FTL', 'Priya Raman', 'PR')
  stateStrip(x, y + 104, w, C.ok, 'ROLLING', '97 km/h · 401 EB')

  const px = x + 16
  const pw = w - 32

  // — the offer leads —
  g('driver A / offer card', () => {
    const y0 = y + 150
    const h = 186
    panel(px, y0, pw, h, { accent: C.accent })
    t(px + 16, y0 + 22, 'NEW OFFER · FTL', { size: 10.5, weight: 700, ls: 1.3, fill: C.accent })
    t(px + pw - 14, y0 + 22, 'auto-expires 13:09', {
      size: 10.5, mono: true, fill: C.warn, anchor: 'end', weight: 600,
    })
    t(px + 16, y0 + 54, 'MG-4482', { size: 25, weight: 700, fill: C.text, mono: true, ls: -0.8 })
    t(px + 16, y0 + 76, 'London DC  →  Cambridge DC', { size: 13.5, fill: C.text })
    t(px + 16, y0 + 95, '110 km · due 15:30 · 18,400 kg · $1,240', {
      size: 11.5, mono: true, fill: C.muted,
    })
    divider(px + 14, y0 + 108, pw - 28)
    t(px + 16, y0 + 128, '✓  Cleared before offer', { size: 11.5, weight: 600, fill: C.ok })
    t(px + 16, y0 + 143, 'HOS 4:20 driving left · axle 17,900 / 19,500 kg', {
      size: 10.5, mono: true, fill: C.dim,
    })
    btn(px + 14, y0 + 152 - 2, 208, 40, 'Accept', { kind: 'ok', size: 14, weight: 700 })
    btn(px + 230, y0 + 152 - 2, pw - 244, 40, 'Reject', { kind: 'ghost', size: 14 })
  })

  // — hours of service —
  g('driver A / hours of service', () => {
    const y0 = y + 348
    panel(px, y0, pw, 178, { title: 'HOURS OF SERVICE', aside: 'CYCLE 1 · 70 h / 7 d' })
    hosRows(px + 16, y0 + 52, pw - 32, HOS_FULL)
  })

  // — duty log —
  g('driver A / duty log', () => {
    const y0 = y + 538
    panel(px, y0, pw, 104, { title: 'DUTY LOG · TODAY', aside: 'ELD' })
    dutyStrip(px + 16, y0 + 42, pw - 32, DUTY_DAY, { now: 13.1 })
    dutyLegend(px + 16, y0 + 96)
  })

  // — rest ahead, present but quiet —
  g('driver A / rest ahead', () => {
    const y0 = y + 654
    panel(px, y0, pw, 56)
    t(px + 16, y0 + 22, 'REST AHEAD', { size: 9.5, weight: 700, ls: 1.2, fill: C.dim })
    t(px + 16, y0 + 41, 'ONroute Cambridge North', { size: 13, weight: 600, fill: C.text })
    t(px + pw - 30, y0 + 30, '41 km · 12 free', { size: 11, mono: true, fill: C.muted, anchor: 'end' })
    t(px + pw - 30, y0 + 44, 'open', { size: 10.5, weight: 700, fill: C.ok, anchor: 'end' })
    path(`M ${r(px + pw - 20)} ${r(y0 + 22)} L ${r(px + pw - 13)} ${r(y0 + 28)} L ${r(px + pw - 20)} ${r(y0 + 34)}`,
      { stroke: C.dim, sw: 1.6, cap: 'round' })
  })

  g('driver A / today', () => {
    const y0 = y + 722
    panel(px, y0, pw, 46, { fill: C.panel2 })
    const cells = [['Distance', '412 km'], ['Stops', '2 of 3'], ['Detention', '$0']]
    cells.forEach(([l, v], i) => {
      const cx = px + 16 + i * ((pw - 32) / 3)
      t(cx, y0 + 20, l, { size: 9.5, weight: 700, ls: 0.9, fill: C.dim })
      t(cx, y0 + 36, v, { size: 13, mono: true, weight: 700, fill: C.text })
    })
  })

  phoneTabBar(x, y + 782, w, 'Today')
}

function driverB(x, y, w) {
  phoneStatusBar(x, y, w, '08:28')
  phoneHeader(x, y + 46, w, 'GLD-118', 'ON BJ 4821 · FTL', 'Priya Raman', 'PR')
  stateStrip(x, y + 104, w, C.warn, 'DOCKED', 'London DC · 0:08 elapsed')

  const px = x + 16
  const pw = w - 32

  // — the detention clock leads: it is the driver's leverage —
  g('driver B / detention clock', () => {
    const y0 = y + 148
    panel(px, y0, pw, 240, { accent: C.warn })
    t(px + 16, y0 + 22, 'DETENTION CLOCK', { size: 10.5, weight: 700, ls: 1.3, fill: C.warn })
    t(px + pw - 14, y0 + 22, 'GEOFENCE-TIMED', {
      size: 10, weight: 700, ls: 0.8, fill: C.dim, anchor: 'end',
    })
    t(px + 16, y0 + 46, 'London Distribution Centre', { size: 15, weight: 600, fill: C.text })
    t(px + 16, y0 + 64, 'Arrived 08:20:14 · fence.enter · 450 m', {
      size: 10.5, mono: true, fill: C.dim,
    })

    t(px + 16, y0 + 122, '1:52', { size: 52, weight: 700, mono: true, fill: C.warn, ls: -2 })
    t(px + 152, y0 + 108, 'of free time left', { size: 12, fill: C.muted })
    t(px + 152, y0 + 125, 'ends 10:20', { size: 13, mono: true, weight: 700, fill: C.text })

    bar(px + 16, y0 + 138, pw - 32, 6, 0.067, C.warn)
    t(px + 16, y0 + 160, '0:08 used of the 2:00 free window', { size: 10.5, fill: C.dim, mono: true })
    t(px + pw - 16, y0 + 160, '$85.00/h after', {
      size: 10.5, weight: 700, fill: C.warn, anchor: 'end', mono: true,
    })

    divider(px + 14, y0 + 174, pw - 28)
    btn(px + 14, y0 + 186, 168, 38, 'Report delay', { kind: 'warn', size: 13, weight: 700 })
    btn(px + 190, y0 + 186, pw - 204, 38, 'Call dispatch', { kind: 'ghost', size: 13 })
  })

  // — what the history says will happen —
  g('driver B / projection', () => {
    const y0 = y + 398
    panel(px, y0, pw, 76, { fill: C.panel2 })
    t(px + 16, y0 + 21, 'THIS DOCK, LAST 30 DAYS', { size: 9.5, weight: 700, ls: 1.1, fill: C.muted })
    t(px + 16, y0 + 43, 'Median dwell 2:14', { size: 14, weight: 600, fill: C.text })
    t(px + 16, y0 + 61, 'On that history you bill 0:14 — about $19.83.', {
      size: 11, fill: C.dim,
    })
    t(px + pw - 16, y0 + 46, '2:14', { size: 20, mono: true, weight: 700, fill: C.warn, anchor: 'end' })
  })

  g('driver B / load', () => {
    const y0 = y + 484
    panel(px, y0, pw, 56)
    t(px + 16, y0 + 22, 'MG-4482', { size: 14, weight: 700, mono: true, fill: C.text })
    t(px + 16, y0 + 41, 'London DC → Cambridge DC · due 15:30', { size: 11.5, fill: C.muted })
    pill(px + pw - 62, y0 + 18, 'FTL', { stroke: C.line, color: C.accent, w: 46 })
  })

  g('driver B / hours of service', () => {
    const y0 = y + 550
    panel(px, y0, pw, 112, { title: 'HOURS OF SERVICE', aside: 'ON DUTY — NOT DRIVING' })
    hosGrid(px + 16, y0 + 52, pw - 32, [
      { label: 'Driving', value: '0:00 / 13:00', pct: 0.02, color: C.ok },
      { label: 'On duty', value: '1:10 / 14:00', pct: 0.083, color: C.ok },
      { label: 'Elapsed', value: '1:10 / 16:00', pct: 0.073, color: C.ok },
      { label: 'Cycle 1', value: '34:00 / 70:00', pct: 0.486, color: C.ok },
    ])
  })

  g('driver B / duty log', () => {
    const y0 = y + 672
    panel(px, y0, pw, 96, { title: 'DUTY LOG · TODAY', aside: 'ELD' })
    dutyStrip(px + 16, y0 + 42, pw - 32, [
      { k: 'off', hours: 6.9 }, { k: 'duty', hours: 0.4 }, { k: 'driving', hours: 0.9 },
      { k: 'duty', hours: 0.27 }, { k: 'off', hours: 15.53 },
    ], { now: 8.47 })
  })

  phoneTabBar(x, y + 782, w, 'Today')
}

function driverC(x, y, w) {
  phoneStatusBar(x, y, w, '19:12')
  phoneHeader(x, y + 46, w, 'GLD-118', 'ON BJ 4821 · FTL', 'Priya Raman', 'PR')
  stateStrip(x, y + 104, w, C.crit, 'HOS CRITICAL', '1:45 driving left')

  const px = x + 16
  const pw = w - 32

  g('driver C / clock', () => {
    const y0 = y + 148
    panel(px, y0, pw, 130, { accent: C.crit })
    t(px + 16, y0 + 22, 'DRIVING TIME LEFT', { size: 10.5, weight: 700, ls: 1.3, fill: C.crit })
    t(px + 16, y0 + 66, '1:45', { size: 44, weight: 700, mono: true, fill: C.crit, ls: -1.6 })
    t(px + 136, y0 + 58, '11:15 of 13:00 used', { size: 12, mono: true, fill: C.muted })
    t(px + 136, y0 + 74, 'hard stop 20:57', { size: 12, mono: true, weight: 700, fill: C.text })
    bar(px + 16, y0 + 82, pw - 32, 6, 0.865, C.crit)
    t(px + 16, y0 + 110, 'You cannot reach Milton Intermodal — 218 km, 2:24.', {
      size: 12, weight: 600, fill: C.text,
    })
  })

  // — parking takes the top, because an HOS warning without a stop is half a product —
  g('driver C / recommended stop', () => {
    const y0 = y + 288
    panel(px, y0, pw, 236, { accent: C.accent })
    t(px + 16, y0 + 22, 'RECOMMENDED STOP', { size: 10.5, weight: 700, ls: 1.3, fill: C.accent })
    t(px + pw - 14, y0 + 22, 'CONFIDENCE MED', {
      size: 10, weight: 700, ls: 0.7, fill: C.dim, anchor: 'end',
    })
    t(px + 16, y0 + 52, 'ONroute Trafalgar', { size: 20, weight: 700, fill: C.text, ls: -0.3 })
    t(px + 16, y0 + 72, '18 spaces · 62 km ahead · reachable with 0:31 spare', {
      size: 11.5, fill: C.muted,
    })

    bar(px + 16, y0 + 84, pw - 32, 7, 0.94, C.crit)
    t(px + 16, y0 + 108, '17 occupied · 1 projected free by 20:10', {
      size: 11, mono: true, fill: C.muted,
    })
    t(px + pw - 16, y0 + 108, '94% FULL', {
      size: 11, weight: 700, fill: C.crit, anchor: 'end', mono: true,
    })

    pill(px + 16, y0 + 120, 'ONLY OPTION AHEAD', { stroke: C.crit, color: C.crit, h: 22 })
    pill(px + 168, y0 + 120, 'FLEET-SENSED', { stroke: C.line, color: C.muted, h: 22 })

    divider(px + 14, y0 + 154, pw - 28)
    t(px + 16, y0 + 176, 'Decide within 0:40.', { size: 12.5, weight: 700, fill: C.warn })
    t(px + 16, y0 + 192, 'After 19:52 you cannot reach Trafalgar either.', {
      size: 11, fill: C.dim,
    })
    btn(px + 14, y0 + 202, pw - 28, 42, 'Claim a space', { kind: 'primary', size: 15, weight: 700 })
  })

  g('driver C / behind you', () => {
    const y0 = y + 536
    panel(px, y0, pw, 74)
    t(px + 16, y0 + 21, 'BEHIND YOU', { size: 9.5, weight: 700, ls: 1.2, fill: C.dim })
    t(px + 16, y0 + 42, 'ONroute Cambridge North', { size: 13, weight: 600, fill: C.text })
    t(px + 16, y0 + 60, '38 km back · 12 free · open', { size: 11, mono: true, fill: C.muted })
    btn(px + pw - 108, y0 + 26, 92, 32, 'Turn back', { kind: 'ghost', size: 12 })
  })

  g('driver C / dispatch note', () => {
    const y0 = y + 622
    panel(px, y0, pw, 72, { fill: C.panel2 })
    t(px + 16, y0 + 21, 'DISPATCH NOTIFIED 19:11', {
      size: 9.5, weight: 700, ls: 1.1, fill: C.ok,
    })
    t(px + 16, y0 + 42, 'Milton delivery moved to 07:00 tomorrow.', { size: 12, fill: C.text })
    t(px + 16, y0 + 59, 'Customer told. Nothing for you to do.', { size: 11, fill: C.dim })
  })

  g('driver C / clocks', () => {
    const y0 = y + 706
    panel(px, y0, pw, 62, { fill: C.panel })
    hosMini(px + 16, y0 + 22, pw - 32, [
      { short: 'DRIVE', mini: '1:45', pct: 0.865, color: C.crit },
      { short: 'DUTY', mini: '1:30', pct: 0.893, color: C.crit },
      { short: 'ELAPSE', mini: '3:12', pct: 0.8, color: C.warn },
      { short: 'CYCLE', mini: '18:20', pct: 0.738, color: C.warn },
    ])
  })

  phoneTabBar(x, y + 782, w, 'Parking')
}

/* ============== 02 · DISPATCHER — "what needs a human?" ============== */

function valueBar(x, y, w, tiles) {
  const h = 84
  rect(x, y, w, h, { fill: C.panel })
  divider(x, y + h, w)
  const cw = w / tiles.length
  tiles.forEach((tile, i) => {
    const cx = x + i * cw
    if (i) line(cx, y + 16, cx, y + h - 16, C.line)
    statTile(cx + 24, y + 8, cw - 48, h - 16, tile.label, tile.value, {
      box: false, sub: tile.sub, color: tile.color, trend: tile.trend,
      trendColor: tile.trendColor, size: 24, mono: true,
    })
  })
  return y + h + 1
}

function moneyRow(x, y, w, o) {
  t(x, y + 14, o.unit, { size: 12.5, weight: 700, mono: true, fill: C.text })
  t(x + 74, y + 14, o.site, { size: 12.5, fill: C.muted })
  t(x + w, y + 14, o.left, { size: 13, mono: true, weight: 700, fill: o.color, anchor: 'end' })
  bar(x, y + 22, w, 5, o.pct, o.color)
  t(x, y + 42, o.note, { size: 10.5, mono: true, fill: C.dim })
  t(x + w, y + 42, o.amount, { size: 10.5, mono: true, weight: 700, fill: o.color, anchor: 'end' })
}

function feedBar(x, y, w, entries) {
  const h = 38
  rect(x, y, w, h, { fill: C.panel })
  divider(x, y, w)
  t(x + 18, y + 24, 'FEED', { size: 9.5, weight: 700, ls: 1.4, fill: C.faint })
  let cx = x + 60
  entries.forEach((e, i) => {
    t(cx, y + 24, e.at, { size: 11.5, mono: true, fill: C.dim })
    cx += tw(e.at, 11.5, { mono: true }) + 10
    t(cx, y + 24, e.text, { size: 11.5, fill: e.color ?? C.muted })
    cx += tw(e.text, 11.5) + 16
    if (i < entries.length - 1) {
      t(cx, y + 24, '·', { size: 11.5, fill: C.faint })
      cx += 14
    }
  })
}

function mapPanel(x, y, w, h, o = {}) {
  panel(x, y, w, h, { rx: 10 })
  const hh = 48
  t(x + 16, y + 30, 'Highway 401 · Windsor → Scarborough', { size: 13, weight: 600, fill: C.text })
  t(x + 16 + tw('Highway 401 · Windsor → Scarborough', 13, { weight: 600 }) + 14, y + 30,
    '40 units', { size: 11.5, mono: true, fill: C.dim })
  const segW = segWidth(['Road', 'Satellite'])
  segmented(x + w - 16 - segW, y + 11, ['Road', 'Satellite'], o.satellite ? 1 : 0, { h: 26 })
  let tx = x + w - 16 - segW - 14
  const toggles = o.toggles ?? []
  for (let i = toggles.length - 1; i >= 0; i--) {
    const [label, on] = toggles[i]
    const bw = tw(label, 11.5, { weight: 500 }) + 30
    tx -= bw
    rect(tx, y + 11, bw, 26, { rx: 7, fill: on ? C.panel2 : 'none', stroke: on ? C.accent : C.line })
    circle(tx + 12, y + 24, 3.2, on ? C.accent : C.faint)
    t(tx + 20, y + 28, label, { size: 11.5, fill: on ? C.text : C.muted })
    tx -= 8
  }
  divider(x + 1, y + hh, w - 2)
  corridorMap(x + 1, y + hh + 1, w - 2, h - hh - 2, o)
}

/** A speed trace whose flat run is the dock and whose dip is the closure. */
function speedTrace(x, y, w, h, o = {}) {
  const pts = [
    92, 96, 98, 97, 99, 96, 94, 97, 98, 96, 88, 62, 34, 12, 0, 0, 0, 0, 0, 0,
    0, 0, 14, 46, 78, 92, 96, 97, 95, 88, 54, 22, 18, 26, 62, 88, 95, 97, 96, 94,
  ]
  rect(x, y, w, h, { rx: 6, fill: '#10151d', stroke: C.line, sw: 1 })
  for (let i = 1; i < 4; i++)
    line(x + 1, y + (i / 4) * h, x + w - 1, y + (i / 4) * h, C.line, { opacity: 0.5 })
  const max = 110
  const d = pts.map((v, i) => [x + 6 + (i / (pts.length - 1)) * (w - 12), y + h - 6 - (v / max) * (h - 12)])
  path(poly(d) + ` L ${r(d[d.length - 1][0])} ${r(y + h - 1)} L ${r(d[0][0])} ${r(y + h - 1)} Z`,
    { fill: C.accent, opacity: 0.13 })
  path(poly(d), { stroke: C.accent, sw: 1.6, join: 'round', cap: 'round' })
  // annotate the flat run and the dip
  const flat = d[17]
  line(flat[0], y + 4, flat[0], y + h - 4, C.warn, { sw: 1, dash: '3 3', opacity: 0.8 })
  t(flat[0] + 5, y + 14, 'dock 2:45', { size: 9, mono: true, fill: C.warn })
  const dip = d[31]
  line(dip[0], y + 4, dip[0], y + h - 4, C.crit, { sw: 1, dash: '3 3', opacity: 0.8 })
  t(dip[0] + 5, y + 14, 'closure', { size: 9, mono: true, fill: C.crit })
  t(x + 6, y + h - 4, '0', { size: 8.5, mono: true, fill: C.faint })
  t(x + 6, y + 12, '110 km/h', { size: 8.5, mono: true, fill: C.faint })
  if (o.label) t(x, y - 8, o.label, { size: 9.5, weight: 700, ls: 1, fill: C.muted })
}

function dispatcherShell(X, Y, W, H, active) {
  topBar(X, Y, W, 'Dispatch', { who: 'Dispatch · Kwame Okafor', initials: 'KO', clock: '13:05:22' })
}

function dispatcherCalm(X, Y, W, H) {
  dispatcherShell(X, Y, W, H)
  valueBar(X, Y + 53, W, [
    { label: 'DETENTION BILLABLE TODAY', value: '$1,240', sub: '4 closed visits · 2 accruing',
      color: C.ok, trend: '▲', trendColor: C.ok },
    { label: 'EMPTY KILOMETRES SAVED', value: '2,610 km', sub: 'vs naive · $3,915 at $1.50/km',
      color: C.text },
    { label: 'QUOTES WAITING', value: '3', sub: '≈ $9,000 at risk · median age 11 min',
      color: C.warn },
    { label: 'CLEARED WITHOUT A HUMAN', value: '12 / 12', sub: 'loads assigned today',
      color: C.accent },
  ])

  const y0 = Y + 154
  const colW = 420
  const cx = X + 16

  // — the queue. It should be empty. That is the product. —
  g('dispatcher / needs you', () => {
    panel(cx, y0, colW, 206, { title: 'NEEDS YOU', aside: 'AUTOMATION HANDLED THE REST' })
    circle(cx + 104, y0 + 16, 10, C.panel2, { stroke: C.line })
    t(cx + 104, y0 + 20, '0', { size: 11.5, weight: 700, mono: true, fill: C.ok, anchor: 'middle' })
    circle(cx + colW / 2, y0 + 92, 26, 'none', { stroke: C.ok, sw: 1.6, opacity: 0.5 })
    path(`M ${r(cx + colW / 2 - 11)} ${r(y0 + 92)} L ${r(cx + colW / 2 - 3)} ${r(y0 + 100)} L ${r(cx + colW / 2 + 12)} ${r(y0 + 83)}`,
      { stroke: C.ok, sw: 2.6, cap: 'round', join: 'round' })
    t(cx + colW / 2, y0 + 138, 'Nothing needs you', {
      size: 16, weight: 600, fill: C.text, anchor: 'middle',
    })
    t(cx + colW / 2, y0 + 158, '38 running · 2 resting · 0 in violation', {
      size: 12, fill: C.muted, anchor: 'middle',
    })
    t(cx + colW / 2, y0 + 176, '12 loads assigned today, all cleared automatically', {
      size: 11.5, fill: C.dim, anchor: 'middle',
    })
    t(cx + colW / 2, y0 + 194, '→ 3 quotes waiting', {
      size: 11.5, weight: 600, fill: C.accent, anchor: 'middle',
    })
  })

  // — money in motion: the alert fires when it STARTS costing —
  g('dispatcher / money in motion', () => {
    const my = y0 + 218
    panel(cx, my, colW, 268, { title: 'MONEY IN MOTION', aside: 'DETENTION ACCRUING NOW' })
    const iw = colW - 32
    moneyRow(cx + 16, my + 40, iw, {
      unit: 'GLD-118', site: 'London DC', pct: 0.96, left: '0:08 left', color: C.crit,
      note: 'arrived 11:13 · free ends 13:13', amount: 'then $85.00/h',
    })
    divider(cx + 14, my + 96, iw + 4, { opacity: 0.6 })
    moneyRow(cx + 16, my + 110, iw, {
      unit: 'GLD-127', site: 'Cambridge DC', pct: 0.34, left: '1:19 left', color: C.warn,
      note: 'arrived 12:24 · free ends 14:24', amount: 'then $85.00/h',
    })
    divider(cx + 14, my + 166, iw + 4, { opacity: 0.6 })
    moneyRow(cx + 16, my + 180, iw, {
      unit: 'GLD-133', site: 'Woodstock', pct: 1, left: '+0:41', color: C.crit,
      note: 'billable since 12:24 · escalated', amount: '$58.08',
    })
    divider(cx + 14, my + 226, iw + 4)
    t(cx + 16, my + 250, 'Owed today', { size: 12, fill: C.muted })
    t(cx + colW - 16, my + 250, '$1,240.00', {
      size: 15, mono: true, weight: 700, fill: C.ok, anchor: 'end',
    })
  })

  g('dispatcher / quotes', () => {
    const qy = y0 + 498
    panel(cx, qy, colW, 195, { title: 'QUOTES WAITING', aside: 'THE $15K–$50K LEAK' })
    const rows = [
      ['Maple Foods', 'Milton → London · 22,000 kg', '11 min', '$3,100'],
      ['Cascade Paper', 'Woodstock → Scarborough', '6 min', '$2,850'],
      ['Grewal Produce', 'Chatham → Mississauga', '2 min', '$3,050'],
    ]
    rows.forEach((row, i) => {
      const ry = qy + 44 + i * 42
      t(cx + 16, ry + 12, row[0], { size: 12.5, weight: 600, fill: C.text })
      t(cx + 16, ry + 28, row[1], { size: 11, fill: C.dim })
      t(cx + colW - 16, ry + 12, row[3], {
        size: 12.5, mono: true, weight: 700, fill: C.ok, anchor: 'end',
      })
      t(cx + colW - 16, ry + 28, `waiting ${row[2]}`, {
        size: 10.5, mono: true, fill: i === 0 ? C.warn : C.dim, anchor: 'end',
      })
      if (i < 2) divider(cx + 14, ry + 36, colW - 28, { opacity: 0.5 })
    })
  })

  mapPanel(X + 452, y0, W - 468, 693, {
    satellite: false,
    toggles: [['Breadcrumbs', false], ['Incidents 3', true]],
  })

  feedBar(X, Y + 862, W, [
    { at: '13:05:12', text: 'GLD-118 fence.enter London DC', color: C.muted },
    { at: '13:04:48', text: 'MG-4482 → GLD-124 · empty 0 km', color: C.ok },
    { at: '13:03:31', text: 'GLD-133 detention started · Woodstock', color: C.warn },
    { at: '13:02:07', text: 'admin set detention.rate 80.00 → 85.00', color: C.dim },
  ])
}

function dispatcherException(X, Y, W, H) {
  dispatcherShell(X, Y, W, H)
  valueBar(X, Y + 53, W, [
    { label: 'DETENTION BILLABLE TODAY', value: '$1,446', sub: '5 closed visits · 1 accruing',
      color: C.ok, trend: '▲', trendColor: C.ok },
    { label: 'EMPTY KILOMETRES SAVED', value: '2,610 km', sub: 'vs naive · $3,915 at $1.50/km',
      color: C.text },
    { label: 'AT RISK RIGHT NOW', value: '$4,200', sub: '1 delivery slipping to tomorrow',
      color: C.crit },
    { label: 'CLEARED WITHOUT A HUMAN', value: '11 / 12', sub: '1 needs a decision',
      color: C.warn },
  ])

  const y0 = Y + 154
  const colW = 420
  const cx = X + 16

  // — when something breaks, only this column changes —
  g('dispatcher / needs you (1)', () => {
    panel(cx, y0, colW, 356, { title: 'NEEDS YOU', aside: 'ONE DECISION', titleFill: C.crit })
    circle(cx + 104, y0 + 16, 10, '#2a1614', { stroke: C.crit })
    t(cx + 104, y0 + 20, '1', { size: 11.5, weight: 700, mono: true, fill: C.crit, anchor: 'middle' })

    const k = y0 + 40
    const kw = colW - 28
    panel(cx + 14, k, kw, 302, { fill: C.panel2, accent: C.crit, rx: 8 })
    circle(cx + 30, k + 22, 4, C.crit)
    t(cx + 42, k + 26, 'GLD-118 · Priya Raman', { size: 14, weight: 700, fill: C.text })
    t(cx + kw + 2, k + 26, '13:04', { size: 11, mono: true, fill: C.dim, anchor: 'end' })

    t(cx + 30, k + 52, 'Cannot reach Milton Intermodal.', { size: 15, weight: 600, fill: C.crit })

    const facts = [
      ['401 closure', 'Trafalgar · +38 min · ON511'],
      ['HOS driving ends', '20:00 · hard stop'],
      ['ETA to Milton', '20:30 · 30 min short'],
      ['Rest ahead', 'ONroute Trafalgar · 94% · 1 free'],
      ['Milton delivery', 'slips to 07:00 tomorrow'],
    ]
    facts.forEach((f, i) => {
      const fy = k + 76 + i * 22
      t(cx + 30, fy, f[0], { size: 11.5, fill: C.muted })
      t(cx + kw + 2, fy, f[1], {
        size: 11.5, mono: true, fill: i === 3 ? C.warn : C.text, anchor: 'end',
      })
    })

    divider(cx + 28, k + 196, kw - 28, { opacity: 0.7 })
    t(cx + 30, k + 216, 'The engine already picked one. You can veto it.', {
      size: 11, fill: C.dim,
    })
    btn(cx + 28, k + 226, kw - 28, 34, 'Notify customer — delivery 07:00', {
      kind: 'primary', size: 12.5, weight: 700,
    })
    btn(cx + 28, k + 266, (kw - 40) / 2, 30, 'Reassign morning load', {
      kind: 'ghostText', size: 11.5,
    })
    btn(cx + 28 + (kw - 40) / 2 + 12, k + 266, (kw - 40) / 2, 30, 'Override — give reason', {
      kind: 'ghost', size: 11.5,
    })
  })

  g('dispatcher / money in motion (compressed)', () => {
    const my = y0 + 368
    panel(cx, my, colW, 172, { title: 'MONEY IN MOTION', aside: 'DETENTION ACCRUING NOW' })
    const iw = colW - 32
    moneyRow(cx + 16, my + 40, iw, {
      unit: 'GLD-127', site: 'Cambridge DC', pct: 0.34, left: '1:19 left', color: C.warn,
      note: 'arrived 12:24 · free ends 14:24', amount: 'then $85.00/h',
    })
    divider(cx + 14, my + 96, iw + 4)
    t(cx + 16, my + 122, 'Closed today', { size: 12, fill: C.muted })
    t(cx + colW - 16, my + 122, '5 visits', { size: 12, mono: true, fill: C.text, anchor: 'end' })
    t(cx + 16, my + 148, 'Owed today', { size: 12, fill: C.muted })
    t(cx + colW - 16, my + 148, '$1,446.00', {
      size: 15, mono: true, weight: 700, fill: C.ok, anchor: 'end',
    })
  })

  g('dispatcher / auto-cleared', () => {
    const ay = y0 + 552
    panel(cx, ay, colW, 141, { title: 'CLEARED WITHOUT YOU', aside: 'LAST 60 MIN' })
    const rows = [
      ['12:58', 'MG-4477 → GLD-124', 'empty 18 km'],
      ['12:41', 'GLD-131 rerouted around closure', '+6 min'],
      ['12:33', 'GLD-109 claimed Putnam Lot', '3 free'],
      ['12:20', 'MG-4471 → GLD-107', 'empty 0 km'],
    ]
    rows.forEach((row, i) => {
      const ry = ay + 54 + i * 26
      t(cx + 16, ry, row[0], { size: 11, mono: true, fill: C.dim })
      t(cx + 66, ry, row[1], { size: 11.5, fill: C.muted })
      t(cx + colW - 16, ry, row[2], { size: 11, mono: true, fill: C.ok, anchor: 'end' })
    })
  })

  // — map in satellite, with the selected unit's history and a drill-down —
  const mx = X + 452
  const mw = W - 468
  mapPanel(mx, y0, mw, 693, {
    satellite: true,
    breadcrumbs: true,
    selected: 0.66,
    incident: 0.82,
    toggles: [['Breadcrumbs', true], ['Incidents 3', true]],
  })

  // drill-down: track & trace lives one click from a truck, not on the front page
  g('dispatcher / track and trace drill-down', () => {
    const iw = 330
    const ix = mx + mw - iw - 14
    const iy = y0 + 693 - 400 - 14
    panel(ix, iy, iw, 400, { fill: '#0f141c', rx: 10 })
    rect(ix, iy, iw, 400, { rx: 10, fill: 'none', stroke: C.accent, sw: 1, opacity: 0.5 })
    t(ix + 14, iy + 24, 'GLD-118', { size: 15, weight: 700, mono: true, fill: C.text })
    t(ix + iw - 14, iy + 24, 'TRACK & TRACE', {
      size: 9.5, weight: 700, ls: 1.1, fill: C.accent, anchor: 'end',
    })
    t(ix + 14, iy + 41, 'Priya Raman · ON BJ 4821 · laden', { size: 11, fill: C.muted })
    divider(ix + 1, iy + 54, iw - 2)

    speedTrace(ix + 14, iy + 78, iw - 28, 92, { label: 'SPEED · LAST 6 h' })

    const rows = [
      ['Leg distance', '187.4 km'],
      ['Shift distance', '412.9 km'],
      ['Odometer', '318,440 km'],
      ['Avg / max speed', '88 / 104 km/h'],
      ['Breadcrumbs', '1,412 pings · 30 s'],
    ]
    rows.forEach((row, i) => {
      const ry = iy + 200 + i * 24
      kv(ix + 14, ry, iw - 28, row[0], row[1], { size: 11.5 })
    })

    divider(ix + 14, iy + 326, iw - 28)
    t(ix + 14, iy + 346, 'CLOSED DOCK RECORD', { size: 9.5, weight: 700, ls: 1.1, fill: C.muted })
    t(ix + 14, iy + 366, 'London DC · 10:20 → 13:05', { size: 11.5, mono: true, fill: C.text })
    t(ix + iw - 14, iy + 366, '2:45 billable', {
      size: 11.5, mono: true, weight: 700, fill: C.ok, anchor: 'end',
    })
    t(ix + 14, iy + 384, 'fence.enter / fence.exit — not typed by anyone', {
      size: 10, fill: C.dim,
    })
    t(ix + iw - 14, iy + 384, '$206.25', {
      size: 12, mono: true, weight: 700, fill: C.ok, anchor: 'end',
    })
  })

  feedBar(X, Y + 862, W, [
    { at: '13:04:55', text: 'GLD-118 cannot reach Milton — queued for a human', color: C.crit },
    { at: '13:04:12', text: 'ON511 closure 401 EB @ Trafalgar', color: C.warn },
    { at: '13:03:40', text: 'GLD-118 fence.exit London DC · 2:45 billable · $206.25', color: C.ok },
  ])
}

/* ====== 03 · SYSTEM — "what did the automation decide, and why?" ====== */

function emptyKmChart(x, y, w, h) {
  const naive = [0, 380, 760, 1180, 1560, 1980, 2340, 2760, 3150, 3520, 3860, 4180]
  const corr = [0, 210, 430, 690, 940, 1210, 1480, 1720, 1960, 2180, 2400, 2610]
  const max = 4600
  const px = x + 54
  const pw = w - 54 - 132
  const py = y + 10
  const ph = h - 40
  const at = (arr, i) => [px + (i / (arr.length - 1)) * pw, py + ph - (arr[i] / max) * ph]

  for (let v = 0; v <= 4000; v += 1000) {
    const gy = py + ph - (v / max) * ph
    line(px, gy, px + pw, gy, C.line, { opacity: v === 0 ? 1 : 0.45 })
    t(px - 10, gy + 4, v.toLocaleString('en-CA'), {
      size: 10, mono: true, fill: C.faint, anchor: 'end',
    })
  }
  ;['06:00', '10:00', '14:00', '18:00'].forEach((lab, i) => {
    const gx = px + (i / 3) * pw
    line(gx, py + ph, gx, py + ph + 4, C.line)
    t(gx, py + ph + 18, lab, { size: 10, mono: true, fill: C.faint, anchor: 'middle' })
  })

  const dn = naive.map((_, i) => at(naive, i))
  const dc = corr.map((_, i) => at(corr, i))
  // the gap is the product
  path(poly(dn) + ' ' + poly([...dc].reverse()).replace('M', 'L') + ' Z',
    { fill: C.ok, opacity: 0.09 })
  path(poly(dn), { stroke: C.crit, sw: 2, join: 'round', dash: '5 4' })
  path(poly(dc), { stroke: C.ok, sw: 2.4, join: 'round' })
  circle(dn[11][0], dn[11][1], 3.5, C.crit)
  circle(dc[11][0], dc[11][1], 3.5, C.ok)

  t(dn[11][0] + 10, dn[11][1] + 4, 'naive  4,180 km', { size: 11.5, mono: true, fill: C.crit, weight: 600 })
  t(dc[11][0] + 10, dc[11][1] + 4, 'corridor  2,610 km', { size: 11.5, mono: true, fill: C.ok, weight: 600 })

  const midY = (dn[8][1] + dc[8][1]) / 2
  line(dn[8][0], dn[8][1], dn[8][0], dc[8][1], C.ok, { sw: 1, dash: '3 3', opacity: 0.8 })
  t(dn[8][0] + 8, midY, 'saved 1,570 km', { size: 12, weight: 700, fill: C.ok })
  t(dn[8][0] + 8, midY + 16, '≈ $2,355 at $1.50/km', { size: 11, mono: true, fill: C.muted })
}

function systemPortal(X, Y, W, H) {
  topBar(X, Y, W, 'System', { who: 'Audit · read-only', initials: 'SY', clock: '13:05:22' })

  // header
  const hy = Y + 53
  rect(X, hy, W, 56, { fill: C.bg })
  divider(X, hy + 56, W)
  t(X + 24, hy + 27, 'System', { size: 17, weight: 700, fill: C.text })
  t(X + 24, hy + 45, 'Every number below is a fold over the event log. Nothing here is asserted.', {
    size: 11.5, fill: C.dim,
  })
  btn(X + W - 24 - 100, hy + 15, 100, 27, 'Replay log', { kind: 'ghost', size: 11.5, rx: 7 })
  const segW = segWidth(['Naive', 'Corridor'], { size: 12 })
  const segX = X + W - 24 - 100 - 16 - segW
  segmented(segX, hy + 15, ['Naive', 'Corridor'], 1, { h: 27, size: 12 })
  t(segX - 12, hy + 33, 'POLICY', {
    size: 9.5, weight: 700, ls: 1.2, fill: C.muted, anchor: 'end',
  })

  const cx = X + 24
  const cw = W - 48

  // — row 1: the empty-kilometre argument —
  g('system / empty kilometres', () => {
    const ry = Y + 121
    panel(cx, ry, 1000, 286, {
      title: 'EMPTY KILOMETRES', aside: 'CORRIDOR vs NAIVE · SAME SEED, SAME LOADS',
    })
    emptyKmChart(cx + 8, ry + 40, 1000 - 16, 236)

    const sx = cx + 1016
    panel(sx, ry, 376, 286, { title: 'WHAT THAT IS WORTH', aside: 'ADMIN-SET RATES' })
    const tiles = [
      ['EMPTY KM AVOIDED', '1,570 km', '$1.50 / km', C.ok],
      ['DETENTION RECOVERED', '$1,446', '4 closed visits at $85.00/h', C.ok],
      ['QUOTES ANSWERED', '9 of 12', '3 open · $9,000 exposed', C.warn],
    ]
    tiles.forEach((tile, i) => {
      const ty = ry + 44 + i * 70
      t(sx + 16, ty + 14, tile[0], { size: 9.5, weight: 700, ls: 1.1, fill: C.muted })
      t(sx + 16, ty + 42, tile[1], { size: 24, mono: true, weight: 700, fill: tile[3], ls: -0.5 })
      t(sx + 16, ty + 58, tile[2], { size: 10.5, fill: C.dim })
      if (i < 2) divider(sx + 14, ty + 66, 348, { opacity: 0.6 })
    })
    divider(sx + 14, ry + 250, 348)
    t(sx + 16, ry + 272, 'Recovered today', { size: 12, fill: C.muted })
    t(sx + 360, ry + 272, '$3,801', { size: 17, mono: true, weight: 700, fill: C.ok, anchor: 'end' })
  })

  // — row 2: why this truck, not that one —
  g('system / decision log', () => {
    const ry = Y + 423
    panel(cx, ry, 856, 256, {
      title: 'DECISION LOG', aside: 'RUNNERS-UP AND EXCLUSIONS, NOT JUST WINNERS',
    })
    const entries = [
      {
        at: '13:05', head: 'MG-4482  →  GLD-118', empty: 'empty 0 km',
        lines: [
          ['runner-up', 'GLD-124 · empty 62 km · rejected: further', C.muted],
          ['excluded', 'GLD-131 · HOS 0:40 driving left', C.warn],
          ['excluded', 'GLD-107 · axle 21,200 kg > 19,500 kg', C.crit],
        ],
      },
      {
        at: '12:40', head: 'MG-4477  →  GLD-124', empty: 'empty 18 km',
        lines: [
          ['runner-up', 'GLD-119 · empty 41 km · rejected: further', C.muted],
          ['excluded', 'GLD-112 · cycle 69:20 / 70:00', C.warn],
        ],
      },
    ]
    let ey = ry + 46
    entries.forEach((e, i) => {
      t(cx + 16, ey + 12, e.at, { size: 12, mono: true, weight: 700, fill: C.dim })
      t(cx + 66, ey + 12, e.head, { size: 13.5, mono: true, weight: 700, fill: C.text })
      pill(cx + 300, ey, e.empty, { stroke: C.line, color: C.ok, h: 20, size: 10.5 })
      t(cx + 840, ey + 12, 'assignment appended to log', {
        size: 10.5, fill: C.faint, anchor: 'end',
      })
      e.lines.forEach((ln, k) => {
        const ly = ey + 34 + k * 20
        t(cx + 66, ly, ln[0], { size: 10.5, weight: 700, ls: 0.5, fill: C.faint })
        t(cx + 140, ly, ln[1], { size: 11.5, mono: true, fill: ln[2] })
      })
      ey += 34 + e.lines.length * 20 + 16
      if (i === 0) divider(cx + 14, ey - 10, 828, { opacity: 0.6 })
    })

    // ledger
    const lx = cx + 872
    panel(lx, ry, 520, 256, { title: 'DETENTION LEDGER', aside: 'CLOSED VISITS ONLY' })
    const cols = [16, 130, 250, 340, 504]
    const head = ['UNIT', 'SITE', 'DWELL', 'BILLABLE', 'AMOUNT']
    head.forEach((hd, i) =>
      t(lx + cols[i], ry + 50, hd, {
        size: 9.5, weight: 700, ls: 0.9, fill: C.faint,
        anchor: i === 4 ? 'end' : 'start',
      }),
    )
    divider(lx + 14, ry + 58, 492, { opacity: 0.6 })
    const rows = [
      ['GLD-118', 'London DC', '4:45', '2:45', '$233.75', C.ok],
      ['GLD-104', 'Milton Intermodal', '3:12', '1:12', '$102.00', C.ok],
      ['GLD-122', 'Mississauga DC', '2:36', '0:36', '$51.00', C.ok],
      ['GLD-127', 'Cambridge DC', '1:41', '0:00', '—', C.dim],
      ['GLD-115', 'ONroute Woodstock', '10:02', 'rest', 'not billable', C.dim],
    ]
    rows.forEach((row, i) => {
      const ty = ry + 80 + i * 26
      t(lx + cols[0], ty, row[0], { size: 11.5, mono: true, fill: C.text })
      t(lx + cols[1], ty, row[1], { size: 11.5, fill: C.muted })
      t(lx + cols[2], ty, row[2], { size: 11.5, mono: true, fill: C.muted })
      t(lx + cols[3], ty, row[3], { size: 11.5, mono: true, fill: row[5] })
      t(lx + cols[4], ty, row[4], {
        size: 11.5, mono: true, weight: 700, fill: row[5], anchor: 'end',
      })
    })
    t(lx + 16, ry + 224, 'A rest area is a stop, not a dock. It never bills.', {
      size: 10.5, fill: C.faint,
    })
    divider(lx + 14, ry + 232, 492)
    t(lx + 16, ry + 250, 'Owed today', { size: 12, fill: C.muted })
    t(lx + 504, ry + 250, '$1,446.00', {
      size: 15, mono: true, weight: 700, fill: C.ok, anchor: 'end',
    })
  })

  // — row 3 —
  const ry3 = Y + 695
  const pw3 = (cw - 32) / 3

  g('system / dwell league', () => {
    panel(cx, ry3, pw3, 181, { title: 'DWELL LEAGUE', aside: 'MEDIAN, 30 d' })
    const rows = [
      ['London DC', 214, 1], ['Cambridge DC', 96, 0.45], ['Woodstock', 41, 0.19],
      ['Milton Intermodal', 34, 0.16], ['Mississauga DC', 22, 0.1],
    ]
    rows.forEach((row, i) => {
      const ty = ry3 + 52 + i * 25
      t(cx + 16, ty, row[0], { size: 11.5, fill: C.muted })
      t(cx + pw3 - 16, ty, `${row[1]} min`, {
        size: 11.5, mono: true, weight: 600, anchor: 'end',
        fill: row[2] > 0.9 ? C.crit : row[2] > 0.4 ? C.warn : C.muted,
      })
      bar(cx + 16, ty + 5, pw3 - 32, 3.5, row[2], row[2] > 0.9 ? C.crit : row[2] > 0.4 ? C.warn : C.line)
    })
  })

  g('system / utilisation', () => {
    const ux = cx + pw3 + 16
    panel(ux, ry3, pw3, 181, { title: 'FLEET UTILISATION', aside: '40 UNITS' })
    const segs = [['driving', 31, C.accent], ['dock', 5, C.warn], ['resting', 3, '#3a4a63'], ['idle', 1, C.line]]
    let sx2 = ux + 16
    const total = 40
    const bw = pw3 - 32
    rect(ux + 16, ry3 + 50, bw, 22, { rx: 5, fill: '#161d28' })
    segs.forEach(([, n, col]) => {
      const segw = (n / total) * bw
      rect(sx2, ry3 + 50, segw, 22, { fill: col })
      sx2 += segw
    })
    rect(ux + 16, ry3 + 50, bw, 22, { rx: 5, fill: 'none', stroke: C.line })
    segs.forEach(([label, n, col], i) => {
      const ly = ry3 + 96 + i * 20
      rect(ux + 16, ly - 8, 9, 9, { rx: 2, fill: col })
      t(ux + 31, ly, label, { size: 11.5, fill: C.muted })
      t(ux + pw3 - 16, ly, String(n), {
        size: 11.5, mono: true, weight: 600, fill: C.text, anchor: 'end',
      })
    })
  })

  g('system / log health', () => {
    const lx = cx + (pw3 + 16) * 2
    panel(lx, ry3, pw3, 181, { title: 'EVENT LOG', aside: 'THE ONLY SOURCE OF TRUTH' })
    const rows = [
      ['Events today', '48,912'],
      ['Append rate', '31 / s'],
      ['Full replay', '1.4 s'],
      ['Folds registered', '9'],
      ['State written directly', '0'],
    ]
    rows.forEach((row, i) => {
      const ty = ry3 + 52 + i * 24
      kv(lx + 16, ty, pw3 - 32, row[0], row[1], {
        size: 11.5, valueFill: i === 4 ? C.ok : C.text,
      })
    })
    t(lx + 16, ry3 + 172, 'Replay reproduces every assignment on this page.', {
      size: 10, fill: C.faint,
    })
  })
}

/* ====== 04 · ADMIN — "what is this system configured to be?" ====== */

function lockGlyph(x, y, color) {
  rect(x, y, 9, 7, { rx: 1.5, fill: 'none', stroke: color, sw: 1.2 })
  path(`M ${r(x + 1.8)} ${r(y)} v -2.4 a 2.7 2.7 0 0 1 5.4 0 V ${r(y)}`,
    { stroke: color, sw: 1.2 })
}

/** Editable: commercial terms we chose. Read-only: law, physics, assumption. */
function fieldRow(x, y, w, o) {
  t(x, y + 14, o.label, { size: 12.5, weight: 600, fill: C.text })
  t(x, y + 31, o.note, { size: 10.5, fill: C.dim })
  if (o.editable) {
    const bw = o.bw ?? 128
    rect(x + w - bw, y + 2, bw, 30, {
      rx: 6, fill: C.bg, stroke: o.focus ? C.accent : C.line, sw: 1,
    })
    t(x + w - bw + 12, y + 22, o.value, { size: 13, mono: true, weight: 600, fill: C.text })
    if (o.unit)
      t(x + w - 12, y + 22, o.unit, { size: 11, mono: true, fill: C.dim, anchor: 'end' })
  } else {
    t(x + w - 78, y + 21, o.value, {
      size: 13, mono: true, weight: 600, fill: C.muted, anchor: 'end',
    })
    lockGlyph(x + w - 62, y + 14, C.faint)
    t(x + w, y + 21, o.tag, {
      size: 9.5, weight: 700, ls: 0.8, fill: C.faint, anchor: 'end',
    })
  }
}

function adminPortal(X, Y, W, H) {
  topBar(X, Y, W, 'Admin', { who: 'Owner · Rae Sandhu', initials: 'RS', clock: '13:05:22' })

  // tabs
  const ty = Y + 53
  rect(X, ty, W, 48, { fill: C.bg })
  divider(X, ty + 48, W)
  const tabs = ['Access', 'Fleet', 'Sites', 'Integrations', 'Audit']
  let tx = X + 24
  tabs.forEach((tab) => {
    const on = tab === 'Fleet'
    const bw = tw(tab, 13, { weight: 600 }) + 30
    t(tx + bw / 2, ty + 30, tab, {
      size: 13, weight: on ? 700 : 500, fill: on ? C.text : C.muted, anchor: 'middle',
    })
    if (on) rect(tx + 8, ty + 44, bw - 16, 2.5, { rx: 1.25, fill: C.accent })
    tx += bw
  })
  t(X + W - 24, ty + 30, 'Nothing on this console dispatches anything.', {
    size: 11.5, fill: C.faint, anchor: 'end',
  })

  const cx = X + 24
  const ry = Y + 117

  // — editable —
  g('admin / commercial terms (editable)', () => {
    const w = 680
    panel(cx, ry, w, 366, { title: 'COMMERCIAL TERMS', aside: 'EDITABLE', asideFill: C.ok })
    rect(cx + w - 92, ry + 10, 78, 18, { rx: 9, fill: C.ok, opacity: 0.14 })
    t(cx + 16, ry + 48, 'Terms we chose. A judge will ask where the dollars came from.', {
      size: 11, fill: C.dim,
    })
    const iw = w - 32
    const rows = [
      { label: 'Detention rate', note: 'Per billable hour, per FTL dock visit',
        value: '85.00', unit: '$/h', editable: true, focus: true },
      { label: 'Free dock window', note: "The brief's default — a contract term, not a law",
        value: '120', unit: 'min', editable: true },
      { label: 'Cost per empty kilometre', note: 'Prices the whole empty-mile claim',
        value: '1.50', unit: '$/km', editable: true },
      { label: 'Missed-quote value', note: 'Brief gives a $1,000–$7,000 range, not a number',
        value: '3,000', unit: '$', editable: true },
      { label: 'Axle limit default', note: 'Per-unit values override this in the table below',
        value: '19,500', unit: 'kg', editable: true },
    ]
    rows.forEach((row, i) => {
      const fy = ry + 62 + i * 50
      fieldRow(cx + 16, fy, iw, row)
      if (i < rows.length - 1) divider(cx + 14, fy + 42, w - 28, { opacity: 0.55 })
    })
    divider(cx + 14, ry + 314, w - 28)
    t(cx + 16, ry + 338, 'HOS cycle', { size: 12.5, weight: 600, fill: C.text })
    t(cx + 16, ry + 355, 'A carrier-level choice — which is exactly this console’s job', { size: 10.5, fill: C.dim })
    segmented(cx + w - 300, ry + 330, ['Cycle 1 · 70 h / 7 d', 'Cycle 2 · 120 h / 14 d'], 0, { h: 26 })
  })

  // — read-only —
  g('admin / law and assumptions (read-only)', () => {
    const rx2 = cx + 696
    const w = 696
    panel(rx2, ry, w, 366, {
      title: 'LAW, PHYSICS & STATED ASSUMPTIONS', aside: 'READ-ONLY', asideFill: C.warn,
    })
    t(rx2 + 16, ry + 48, 'An editable legal limit is a compliance product lying.', {
      size: 11, fill: C.dim,
    })
    const iw = w - 32
    const rows = [
      { label: 'Driving limit', note: 'Canadian federal HOS', value: '13:00', tag: 'LAW' },
      { label: 'On-duty limit', note: 'Canadian federal HOS', value: '14:00', tag: 'LAW' },
      { label: 'Elapsed window', note: 'Since the last 8 h core rest', value: '16:00', tag: 'LAW' },
      { label: 'Off-duty reset', note: '10 h total, 8 h of it consecutive', value: '10:00 / 8:00', tag: 'LAW' },
      { label: 'Geofence radii', note: 'Sim sizes its sub-step from the smallest fence at boot',
        value: '260 – 550 m', tag: 'PHYSICS' },
      { label: 'FLEET_SHARE', note: 'Surfaced so it is arguable, not tuned until the demo looks good',
        value: '0.18', tag: 'ASSUMPTION' },
    ]
    rows.forEach((row, i) => {
      const fy = ry + 62 + i * 44
      fieldRow(rx2 + 16, fy, iw, row)
      if (i < rows.length - 1) divider(rx2 + 14, fy + 38, w - 28, { opacity: 0.55 })
    })
    divider(rx2 + 14, ry + 332, w - 28)
    t(rx2 + 16, ry + 354, 'Every field says which of the two it is, inline — you should not have to discover it by trying.',
      { size: 10.5, fill: C.faint })
  })

  // — fleet table —
  g('admin / fleet', () => {
    const fy = Y + 499
    const w = 880
    panel(cx, fy, w, 377, { title: 'FLEET', aside: '40 UNITS · 6 SHOWN' })
    const cols = [16, 118, 232, 400, 500, 632, 760]
    const head = ['UNIT', 'PLATE', 'DRIVER', 'TARE kg', 'AXLE LIMIT kg', 'CYCLE', 'STATE']
    head.forEach((h2, i) =>
      t(cx + cols[i], fy + 52, h2, { size: 9.5, weight: 700, ls: 0.9, fill: C.faint }),
    )
    divider(cx + 14, fy + 60, w - 28, { opacity: 0.7 })
    const rows = [
      ['GLD-107', 'ON QF 2210', 'Amrit Basra', '15,900', '19,500', 'Cycle 1', 'driving', C.ok],
      ['GLD-118', 'ON BJ 4821', 'Priya Raman', '16,100', '19,500', 'Cycle 1', 'docked', C.warn],
      ['GLD-124', 'ON LT 7734', 'Bev Cormier', '15,400', '19,500', 'Cycle 1', 'driving', C.ok],
      ['GLD-127', 'ON MK 1180', 'Cal Duong', '16,700', '21,000', 'Cycle 2', 'docked', C.warn],
      ['GLD-131', 'ON RS 9042', 'Dev Ellis', '15,800', '19,500', 'Cycle 1', 'resting', '#7d8ea8'],
      ['GLD-133', 'ON TP 3306', 'Eli Fontaine', '16,250', '19,500', 'Cycle 1', 'docked', C.crit],
    ]
    rows.forEach((row, i) => {
      const yy = fy + 80 + i * 47
      rect(cx + 14, yy - 16, w - 28, 44, { rx: 6, fill: i % 2 ? 'none' : C.panel2, opacity: 0.55 })
      t(cx + cols[0], yy + 6, row[0], { size: 12, mono: true, weight: 600, fill: C.text })
      t(cx + cols[1], yy + 6, row[1], { size: 11.5, mono: true, fill: C.muted })
      t(cx + cols[2], yy + 6, row[2], { size: 12, fill: C.muted })
      t(cx + cols[3] + 60, yy + 6, row[3], { size: 11.5, mono: true, fill: C.muted, anchor: 'end' })
      rect(cx + cols[4], yy - 10, 92, 28, { rx: 6, fill: C.bg, stroke: C.line })
      t(cx + cols[4] + 10, yy + 6, row[4], { size: 11.5, mono: true, weight: 600, fill: C.text })
      t(cx + cols[5], yy + 6, row[5], { size: 11.5, fill: C.muted })
      circle(cx + cols[6] + 5, yy + 2, 3.5, row[7])
      t(cx + cols[6] + 16, yy + 6, row[6], { size: 11.5, fill: row[7] })
    })
    divider(cx + 14, fy + 350, w - 28)
    t(cx + 16, fy + 368, 'Tare and axle limit are equipment facts and vary per unit — so they are editable here and nowhere else.',
      { size: 10.5, fill: C.faint })
  })

  // — audit —
  g('admin / audit', () => {
    const ay = Y + 499
    const ax = cx + 896
    const w = 496
    panel(ax, ay, w, 377, { title: 'AUDIT', aside: 'APPENDED TO THE SAME LOG' })
    t(ax + 16, ay + 50, 'A config change applied as a side effect would be the one thing', {
      size: 10.5, fill: C.dim,
    })
    t(ax + 16, ay + 64, 'in this system nobody could reconstruct by replaying.', {
      size: 10.5, fill: C.dim,
    })
    const rows = [
      ['13:02:07', 'rae@gladiolus', 'detention.rate', '80.00 → 85.00', C.ok],
      ['11:48:51', 'rae@gladiolus', 'quote.value', '2,500 → 3,000', C.ok],
      ['10:15:02', 'kwame@gladiolus', 'GLD-127 cycle', 'Cycle 1 → Cycle 2', C.accent],
      ['09:33:40', 'rae@gladiolus', 'onr-trafalgar.spaces', '20 → 18', C.warn],
      ['08:02:12', 'system', 'log.replay', 'verified · 48,912 events', C.dim],
      ['07:59:00', 'rae@gladiolus', 'GLD-127 axle limit', '19,500 → 21,000', C.ok],
    ]
    rows.forEach((row, i) => {
      const yy = ay + 88 + i * 43
      t(ax + 16, yy, row[0], { size: 11, mono: true, fill: C.dim })
      t(ax + 90, yy, row[1], { size: 11, fill: C.faint })
      t(ax + 16, yy + 17, row[2], { size: 12, weight: 600, fill: C.text })
      t(ax + w - 16, yy + 17, row[3], {
        size: 11.5, mono: true, weight: 600, fill: row[4], anchor: 'end',
      })
      if (i < rows.length - 1) divider(ax + 14, yy + 28, w - 28, { opacity: 0.45 })
    })
    divider(ax + 14, ay + 350, w - 28)
    t(ax + 16, ay + 368, 'These land in the dispatcher feed alongside everything else.', {
      size: 10.5, fill: C.faint,
    })
  })
}

/* ====== 05 · CUSTOMER — "where is my freight?" ====== */

function customerPortal(x, y, w) {
  phoneStatusBar(x, y, w, '13:05')

  const px = x + 16
  const pw = w - 32

  rect(x, y + 46, w, 54, { fill: C.panel })
  divider(x, y + 100, w)
  t(x + 18, y + 68, 'Gladiolus', { size: 12, weight: 700, fill: C.muted })
  t(x + 18 + tw('Gladiolus ', 12, { weight: 700 }), y + 68, 'Corridor', {
    size: 12, weight: 700, fill: C.accent,
  })
  t(x + 18, y + 88, 'MG-4482 · Maple Foods', { size: 13.5, weight: 600, fill: C.text })
  pill(x + w - 92, y + 60, 'NO SIGN-IN', { stroke: C.line, color: C.dim, h: 20 })

  stateStrip(x, y + 100, w, C.warn, 'AT YOUR DOCK', 'London DC · since 10:20')

  // — the deliberate decision: show the customer their own clock —
  g('customer / your detention clock', () => {
    const y0 = y + 146
    panel(px, y0, pw, 190, { accent: C.warn })
    t(px + 16, y0 + 22, 'YOUR DOCK TIME', { size: 10.5, weight: 700, ls: 1.3, fill: C.warn })
    t(px + pw - 14, y0 + 22, 'LIVE', { size: 10, weight: 700, ls: 0.8, fill: C.crit, anchor: 'end' })
    t(px + 16, y0 + 74, '2:45', { size: 46, weight: 700, mono: true, fill: C.warn, ls: -1.8 })
    t(px + 142, y0 + 60, 'billable so far', { size: 12, fill: C.muted })
    t(px + 142, y0 + 78, '$233.75', { size: 15, mono: true, weight: 700, fill: C.text })
    bar(px + 16, y0 + 90, pw - 32, 6, 1, C.warn)
    t(px + 16, y0 + 112, 'Free 2:00 ended 10:20 · $85.00/h after', {
      size: 11, mono: true, fill: C.dim,
    })
    divider(px + 14, y0 + 126, pw - 28)
    t(px + 16, y0 + 146, 'Both of us are watching the same clock.', {
      size: 12, weight: 600, fill: C.text,
    })
    t(px + 16, y0 + 163, 'Timestamped by geofence at 08:20:14 and 10:20:14 —', {
      size: 10.5, fill: C.dim,
    })
    t(px + 16, y0 + 177, 'not typed in by a dispatcher at month end.', { size: 10.5, fill: C.dim })
  })

  g('customer / route', () => {
    const y0 = y + 348
    panel(px, y0, pw, 118, { title: 'ROUTE', aside: 'ETA 15:30' })
    const rx2 = px + 30
    const rw = pw - 76
    line(rx2, y0 + 62, rx2 + rw, y0 + 62, C.line, { sw: 3 })
    line(rx2, y0 + 62, rx2 + rw * 0.55, y0 + 62, C.accent, { sw: 3 })
    const stops = [
      [0, 'London DC', '08:20', C.ok],
      [0.55, 'On the 401', 'now', C.accent],
      [1, 'Cambridge DC', '15:30', C.dim],
    ]
    stops.forEach(([f, label, at, col]) => {
      const sx2 = rx2 + rw * f
      circle(sx2, y0 + 62, 6, C.panel, { stroke: col, sw: 2.4 })
      if (f === 0.55) circle(sx2, y0 + 62, 2.6, col)
      t(sx2, y0 + 48, label, {
        size: 11, weight: 600, fill: col === C.dim ? C.muted : C.text,
        anchor: f === 0 ? 'start' : f === 1 ? 'end' : 'middle',
      })
      t(sx2, y0 + 84, at, {
        size: 10.5, mono: true, fill: C.dim,
        anchor: f === 0 ? 'start' : f === 1 ? 'end' : 'middle',
      })
    })
    t(px + 16, y0 + 106, '110 km · 62 km remaining · on time', { size: 10.5, fill: C.faint })
  })

  g('customer / map', () => {
    const y0 = y + 478
    panel(px, y0, pw, 150, { title: 'LIVE POSITION', aside: 'UPDATED 12 s AGO' })
    corridorMap(px + 1, y0 + 36, pw - 2, 113, { selected: 0.63, compact: true })
  })

  g('customer / timeline', () => {
    const y0 = y + 640
    panel(px, y0, pw, 128, { title: 'TIMELINE', aside: 'FROM THE EVENT LOG' })
    const rows = [
      ['13:05', 'Departed London DC', C.warn],
      ['10:20', 'Free dock time ended', C.warn],
      ['08:20', 'Arrived London DC', C.muted],
      ['06:02', 'Load MG-4482 assigned', C.dim],
    ]
    rows.forEach((row, i) => {
      const yy = y0 + 54 + i * 22
      circle(px + 22, yy - 4, 3, row[2])
      if (i < rows.length - 1) line(px + 22, yy - 1, px + 22, yy + 15, C.line)
      t(px + 36, yy, row[0], { size: 11, mono: true, fill: C.dim })
      t(px + 82, yy, row[1], { size: 11.5, fill: row[2] })
    })
  })

  t(x + w / 2, y + 794, 'Read-only link. Expires when MG-4482 is delivered.', {
    size: 10.5, fill: C.faint, anchor: 'middle',
  })
  t(x + w / 2, y + 810, 'gladiolus.co/t/MG-4482', {
    size: 10.5, mono: true, fill: C.dim, anchor: 'middle',
  })
}

/* ---------- board annotations ---------- */

function specSheet(x, y, w, h) {
  g('spec sheet', () => {
    panel(x, y, w, h, { rx: 12, fill: '#0d1119' })
    t(x + 28, y + 40, 'Design spec', { size: 22, weight: 700, fill: C.text, ls: -0.3 })
    t(x + 28, y + 60, 'Tokens are src/styles.css verbatim — the board and the build cannot drift.', {
      size: 12, fill: C.dim,
    })
    divider(x + 24, y + 78, w - 48)

    // colour
    t(x + 28, y + 106, 'COLOUR', { size: 10, weight: 700, ls: 1.4, fill: C.muted })
    const swatches = [
      ['--bg', C.bg, 'page'], ['--panel', C.panel, 'card'], ['--panel-2', C.panel2, 'inset'],
      ['--line', C.line, 'border'], ['--text', C.text, 'primary'],
      ['--muted', C.muted, 'secondary'], ['--accent', C.accent, 'action / 401'],
      ['--ok', C.ok, 'money in'], ['--warn', C.warn, 'accruing'], ['--crit', C.crit, 'needs you'],
    ]
    const sw = (w - 56 - 9 * 12) / 10
    swatches.forEach((s, i) => {
      const sx = x + 28 + i * (sw + 12)
      rect(sx, y + 118, sw, 52, { rx: 7, fill: s[1], stroke: C.line, sw: 1 })
      t(sx, y + 186, s[0], { size: 10.5, mono: true, weight: 600, fill: C.text })
      t(sx, y + 200, s[1], { size: 9.5, mono: true, fill: C.faint })
      t(sx, y + 214, s[2], { size: 9.5, fill: C.dim })
    })
    divider(x + 24, y + 234, w - 48)

    // type
    t(x + 28, y + 262, 'TYPE', { size: 10, weight: 700, ls: 1.4, fill: C.muted })
    const specimens = [
      ['MG-4482', 25, 700, true, 'load id · mono 25/700'],
      ['$1,240', 24, 700, true, 'stat · mono 24/700'],
      ['Nothing needs you', 17, 600, false, 'panel title · 17/600'],
      ['London DC → Cambridge DC', 13.5, 400, false, 'body · 13.5/400'],
      ['110 km · due 15:30', 11.5, 400, true, 'meta · mono 11.5/400'],
      ['MONEY IN MOTION', 10.5, 700, false, 'eyebrow · 10.5/700 · +1.3 tracking'],
    ]
    specimens.forEach((s, i) => {
      const sy = y + 292 + i * 30
      t(x + 28, sy, s[0], {
        size: s[1], weight: s[2], mono: s[3], fill: C.text,
        ls: s[4].includes('tracking') ? 1.3 : 0,
      })
      t(x + 340, sy, s[4], { size: 10.5, fill: C.faint })
    })

    // components
    const gx = x + 560
    t(gx, y + 262, 'COMPONENTS', { size: 10, weight: 700, ls: 1.4, fill: C.muted })
    btn(gx, y + 276, 108, 34, 'Accept', { kind: 'ok', size: 13, weight: 700 })
    btn(gx + 118, y + 276, 108, 34, 'Claim', { kind: 'primary', size: 13, weight: 700 })
    btn(gx + 236, y + 276, 108, 34, 'Override', { kind: 'ghost', size: 13 })
    pill(gx, y + 322, 'FTL', { stroke: C.line, color: C.accent, h: 22 })
    pill(gx + 56, y + 322, 'ONLY OPTION AHEAD', { stroke: C.crit, color: C.crit, h: 22 })
    pill(gx + 216, y + 322, 'FLEET-SENSED', { stroke: C.line, color: C.muted, h: 22 })
    segmented(gx, y + 356, ['Road', 'Satellite'], 1, { h: 27 })
    segmented(gx + 168, y + 356, ['Naive', 'Corridor'], 1, { h: 27 })
    ;[['ok · under 60%', 0.33, C.ok], ['warn · 60–90%', 0.78, C.warn], ['crit · over 90%', 0.96, C.crit]]
      .forEach((b, i) => {
        const by = y + 404 + i * 24
        t(gx, by, b[0], { size: 10.5, fill: C.muted })
        bar(gx + 130, by - 5, 200, 5, b[1], b[2])
      })

    divider(x + 24, y + 486, w - 48)

    // frames
    t(x + 28, y + 514, 'FRAMES ON THIS PAGE', { size: 10, weight: 700, ls: 1.4, fill: C.muted })
    const frames = [
      ['Driver · A rolling', 'iPhone 390 × 844', '13:05'],
      ['Driver · B at a dock', 'iPhone 390 × 844', '08:28'],
      ['Driver · C clock low', 'iPhone 390 × 844', '19:12'],
      ['Dispatcher · calm', 'Laptop 1440 × 900', '13:05'],
      ['Dispatcher · exception', 'Laptop 1440 × 900', '13:05'],
      ['System', 'Laptop 1440 × 900', '13:05'],
      ['Admin', 'Laptop 1440 × 900', '13:05'],
      ['Customer link', 'iPhone 390 × 844', '13:05'],
    ]
    frames.forEach((f, i) => {
      const fx = x + 28 + (i % 2) * ((w - 56) / 2)
      const fy = y + 542 + Math.floor(i / 2) * 26
      t(fx, fy, f[0], { size: 11.5, weight: 600, fill: C.text })
      t(fx + 210, fy, f[1], { size: 11, mono: true, fill: C.muted })
      t(fx + 360, fy, f[2], { size: 11, mono: true, fill: C.faint })
    })
    t(x + 28, y + 668, 'The three driver frames are states of one screen, so each carries its own clock. Every other frame is the same instant: 13:05.',
      { size: 11, fill: C.dim })

    divider(x + 24, y + 688, w - 48)
    const half = (w - 56) / 2

    t(x + 28, y + 716, 'GRID & SPACING', { size: 10, weight: 700, ls: 1.4, fill: C.muted })
    const grid = [
      ['Laptop content margin', '24 px'], ['Panel gutter', '16 px'],
      ['Panel padding', '14 / 16 px'], ['Panel radius', '10 px'],
      ['Phone content margin', '16 px'], ['Dispatcher left column', '420 px fixed'],
      ['Tap target minimum', '38 px'], ['Bar height', '4 – 7 px'],
    ]
    grid.forEach((row, i) => {
      kv(x + 28, y + 744 + i * 22, half - 60, row[0], row[1], { size: 11.5 })
    })

    const ix = x + 28 + half + 20
    t(ix, y + 716, 'INTO FIGMA', { size: 10, weight: 700, ls: 1.4, fill: C.accent })
    const steps = [
      ['1', 'Drag corridor-portals.svg onto a Figma page — or File ▸ Import.'],
      ['2', 'Every device, screen and panel arrives as a named group.'],
      ['3', 'Text stays editable; fonts map to Inter and Roboto Mono,'],
      ['', 'both of which Figma ships.'],
      ['4', 'To change anything, edit design/board.mjs and re-run'],
      ['', 'node design/board.mjs — the svg is generated, not drawn.'],
    ]
    steps.forEach((st, i) => {
      const sy = y + 744 + i * 22
      if (st[0]) t(ix, sy, st[0], { size: 11, mono: true, weight: 700, fill: C.accent })
      t(ix + 18, sy, st[1], { size: 11.5, fill: C.muted })
    })
    t(ix, y + 892, 'The Figma MCP connector is not authorised in this workspace, so this', {
      size: 10.5, fill: C.faint,
    })
    t(ix, y + 906, 'board ships as an svg rather than being written into a file directly.', {
      size: 10.5, fill: C.faint,
    })

    t(x + 28, y + 932, 'Dark only — read in a cab, and in a demo room with the lights up. src/styles.css sets color-scheme: dark and never offers a light theme.',
      { size: 10.5, fill: C.faint })
  })
}

function driverNotes(x, y, w, h) {
  // — how the same screen re-orders itself —
  g('note / the driver screen re-orders itself', () => {
    const h1 = 420
    panel(x, y, w, h1, { rx: 12, fill: '#0d1119' })
    t(x + 28, y + 42, 'The driver screen re-orders itself', {
      size: 20, weight: 700, fill: C.text, ls: -0.2,
    })
    t(x + 28, y + 64, 'Same data, reordered. What matters at 08:00 is not what matters when the clock is nearly out — so the emphasis moves with the state rather than the driver hunting for it.',
      { size: 12, fill: C.dim })
    divider(x + 24, y + 82, w - 48)

    const cw = (w - 56 - 32) / 3
    const cols = [
      {
        key: 'A · ROLLING', col: C.ok,
        trig: "truck.state === 'driving'",
        leads: 'The load offer, with Accept / Reject',
        drops: 'Parking falls to one quiet row',
        stack: [['Offer  MG-4482', C.accent, 46], ['Hours of service', C.line, 34],
                ['Duty log', C.line, 22], ['Rest ahead', C.line, 16]],
      },
      {
        key: 'B · AT A DOCK', col: C.warn,
        trig: 'fence.enter at an FTL stop site',
        leads: 'The detention clock, and a way to escalate',
        drops: 'The four clocks compress to a 2 × 2 grid',
        stack: [['Detention  1:52', C.warn, 56], ['This dock, 30 days', C.line, 22],
                ['Load  MG-4482', C.line, 18], ['Hours of service', C.line, 28]],
      },
      {
        key: 'C · CLOCK LOW', col: C.crit,
        trig: 'clockLeftMs(truck) < 90 min',
        leads: 'The recommended stop, and a claim button',
        drops: 'The load card disappears entirely',
        stack: [['1:45 driving left', C.crit, 34], ['ONroute Trafalgar', C.accent, 56],
                ['Behind you', C.line, 20], ['Dispatch notified', C.line, 20]],
      },
    ]

    cols.forEach((c, i) => {
      const cx = x + 28 + i * (cw + 16)
      t(cx, y + 116, c.key, { size: 11, weight: 700, ls: 1.2, fill: c.col })
      t(cx, y + 140, 'TRIGGER', { size: 9.5, weight: 700, ls: 1, fill: C.faint })
      t(cx + 70, y + 140, c.trig, { size: 11.5, mono: true, fill: C.muted })
      t(cx, y + 164, 'LEADS', { size: 9.5, weight: 700, ls: 1, fill: C.faint })
      t(cx + 70, y + 164, c.leads, { size: 11.5, fill: C.text })
      t(cx, y + 186, 'DROPS', { size: 9.5, weight: 700, ls: 1, fill: C.faint })
      t(cx + 70, y + 186, c.drops, { size: 11.5, fill: C.muted })

      // the card stack, at a glance
      let sy = y + 210
      c.stack.forEach((row) => {
        rect(cx, sy, cw, row[2], { rx: 5, fill: C.panel, stroke: C.line, sw: 1 })
        rect(cx, sy, 3, row[2], { rx: 1.5, fill: row[1] })
        t(cx + 14, sy + row[2] / 2 + 4, row[0], {
          size: 11.5, weight: row[1] === C.line ? 400 : 600,
          fill: row[1] === C.line ? C.muted : C.text,
        })
        sy += row[2] + 8
      })
    })

    t(x + 28, y + h1 - 24, 'Never blank this screen because the news is bad. “Trafalgar at 94%, and it is your only option” is actionable; null is not — that is trap 8, on a phone.',
      { size: 11.5, fill: C.faint })
  })

  // — the clocks the states are reacting to —
  g('note / the clocks', () => {
    const y2 = y + 444
    const h2 = h - 444
    panel(x, y2, w, h2, { rx: 12, fill: '#0d1119' })
    t(x + 28, y2 + 42, 'The clocks those states are reacting to', {
      size: 20, weight: 700, fill: C.text, ls: -0.2,
    })
    t(x + 28, y2 + 64, 'Four HOS clocks and one weight gate — all read-only in Admin, because a compliance product that lets you edit the law is lying. And below them, for contrast, the one number here that is editable.',
      { size: 12, fill: C.dim })
    divider(x + 24, y2 + 82, w - 48)

    const cols = [28, 300, 510, 740]
    ;['CLOCK', 'LIMIT', 'RESETS ON', 'WHY IT DECIDES SOMETHING'].forEach((hd, i) =>
      t(x + cols[i], y2 + 108, hd, { size: 9.5, weight: 700, ls: 1.1, fill: C.faint }),
    )
    divider(x + 24, y2 + 118, w - 48, { opacity: 0.6 })

    const rows = [
      ['Driving', '13:00', '10 h off duty', 'The clock drivers already watch. Runs only while the truck is moving.', C.ok],
      ['On duty', '14:00', '10 h off duty', 'A dock wait burns this while the truck is stationary — which is why detention and HOS share a screen.', C.warn],
      ['Elapsed since rest', '16:00', '8 h consecutive core rest', 'The interesting one: it can expire while the truck is parked. No other clock we model does that.', C.crit],
      ['Cycle 1 / Cycle 2', '70 h / 7 d · 120 h / 14 d', '36 h / 72 h off duty', 'A carrier-level choice, so it is set once in Admin and never during a shift.', C.accent],
      ['Axle weight', '19,500 kg per unit', 'n/a — an equipment fact', 'Paired with HOS as one pre-dispatch audit: canAccept returns both kinds of reason from a single call.', '#a78bfa'],
      ['Free dock window', '120 min', 'n/a — resets per visit', 'The one editable number on this list. It is a contract term, not a law, so it belongs to whoever signs the contract.', C.muted],
    ]
    rows.forEach((row, i) => {
      const ry = y2 + 146 + i * 42
      circle(x + cols[0] - 12, ry - 4, 3.5, row[4])
      t(x + cols[0], ry, row[0], { size: 13, weight: 600, fill: C.text })
      t(x + cols[1], ry, row[1], { size: 12, mono: true, fill: row[4] })
      t(x + cols[2], ry, row[2], { size: 12, fill: C.muted })
      t(x + cols[3], ry, row[3], { size: 12, fill: C.muted })
      if (i < rows.length - 1) divider(x + 24, ry + 15, w - 48, { opacity: 0.4 })
    })

    t(x + 28, y2 + h2 - 24, 'An HOS warning with no parking answer is half a product — which is why state C leads with a place to stop rather than a countdown.',
      { size: 11.5, fill: C.faint })
  })
}

function annotations(x, y, w) {
  // one question per portal
  g('note / one question per portal', () => {
    const h = 300
    panel(x, y, w, h, { rx: 12, fill: '#0d1119' })
    t(x + 28, y + 40, 'Each portal answers exactly one question', {
      size: 20, weight: 700, fill: C.text, ls: -0.2,
    })
    t(x + 28, y + 62, 'A widget that does not serve its portal’s question belongs on a different portal, however interesting it is.',
      { size: 12, fill: C.dim })
    divider(x + 24, y + 80, w - 48)
    const cols = [28, 360, 900, 1240]
    ;['PORTAL', 'THE QUESTION IT ANSWERS', 'WHO OPENS IT', 'DEVICE'].forEach((hd, i) =>
      t(x + cols[i], y + 106, hd, { size: 9.5, weight: 700, ls: 1.1, fill: C.faint }),
    )
    divider(x + 24, y + 116, w - 48, { opacity: 0.6 })
    const rows = [
      ['Driver', 'What do I do right now?', 'One driver, on a phone, in a cab', 'Phone', C.accent],
      ['Dispatcher', 'What needs a human?', 'One desk, all forty trucks', 'Laptop', C.ok],
      ['System', 'What did the automation decide, and why?', 'Anyone auditing the engine', 'Laptop', C.warn],
      ['Admin', 'What is this system configured to be?', 'Whoever owns the carrier’s setup', 'Laptop', C.crit],
      ['Customer link', 'Where is my freight?', 'The consignee, no sign-in', 'Phone', C.muted],
    ]
    rows.forEach((row, i) => {
      const ry = y + 144 + i * 27
      circle(x + cols[0] - 12, ry - 4, 3.5, row[4])
      t(x + cols[0], ry, row[0], { size: 13, weight: 600, fill: C.text })
      t(x + cols[1], ry, row[1], { size: 13, fill: C.muted })
      t(x + cols[2], ry, row[2], { size: 12, fill: C.dim })
      t(x + cols[3], ry, row[3], { size: 12, mono: true, fill: C.faint })
    })
    t(x + 28, y + h - 24, 'Not on that list: “where is everything”. Nobody’s job is watching — a map is how you drill into a question, never the answer to one.',
      { size: 11.5, fill: C.faint })
  })

  // the same fact, four framings
  g('note / the same fact, four framings', () => {
    const y2 = y + 324
    const h = 268
    panel(x, y2, w, h, { rx: 12, fill: '#0d1119' })
    t(x + 28, y2 + 40, 'The same fact, four framings', {
      size: 20, weight: 700, fill: C.text, ls: -0.2,
    })
    t(x + 28, y2 + 62, 'Detention appears on every surface above and means something different each time. That is the rule doing its work.',
      { size: 12, fill: C.dim })
    divider(x + 24, y2 + 80, w - 48)
    const cw = (w - 56 - 36) / 4
    const cards = [
      ['DRIVER', 'A clock they can escalate against, while they are still standing at the dock.', '1:52 left', C.warn],
      ['DISPATCHER', 'An alert the moment it starts costing — not when it ends.', '$1,240 ▲', C.ok],
      ['SYSTEM', 'A closed ledger, totalled, and reconstructible by replay.', '$1,446.00', C.accent],
      ['CUSTOMER', 'Their own clock, running, before the invoice arrives.', '2:45 · $233.75', C.crit],
    ]
    cards.forEach((c, i) => {
      const cx2 = x + 28 + i * (cw + 12)
      panel(cx2, y2 + 100, cw, 120, { fill: C.panel, accent: c[3], rx: 8 })
      t(cx2 + 16, y2 + 124, c[0], { size: 10, weight: 700, ls: 1.3, fill: c[3] })
      t(cx2 + 16, y2 + 152, c[2], { size: 19, mono: true, weight: 700, fill: C.text, ls: -0.4 })
      const words = c[1].split(' ')
      let ln = ''
      const lines = []
      words.forEach((wd) => {
        if (tw(ln + ' ' + wd, 11) > cw - 32) { lines.push(ln); ln = wd } else ln = ln ? ln + ' ' + wd : wd
      })
      lines.push(ln)
      lines.slice(0, 3).forEach((l2, k) =>
        t(cx2 + 16, y2 + 176 + k * 14, l2, { size: 11, fill: C.muted }),
      )
    })
    t(x + 28, y2 + h - 24, 'One engine number — billableMin = max(0, dwellMin − 120) at FTL stop sites — rendered four ways. Rest areas never bill.',
      { size: 11.5, fill: C.faint })
  })

  // judged under
  g('note / judged under', () => {
    const y3 = y + 616
    const h = 300
    panel(x, y3, w, h, { rx: 12, fill: '#0d1119' })
    t(x + 28, y3 + 40, 'What each region on these frames is judged under', {
      size: 20, weight: 700, fill: C.text, ls: -0.2,
    })
    t(x + 28, y3 + 62, 'The layouts above were not chosen by taste. Every region earns one of the brief’s seven criteria, or it is not on the frame.',
      { size: 12, fill: C.dim })
    divider(x + 24, y3 + 80, w - 48)
    const rows = [
      ['Top value bar, in dollars', 'Dispatcher', '1 · workflow speed & financial value', C.ok],
      ['Needs-you queue, usually empty', 'Dispatcher', '1, 7 · workflow speed and UI/UX', C.ok],
      ['Money in motion — detention accruing', 'Dispatcher', '2 · geofencing & detention precision', C.warn],
      ['Detention clock', 'Driver B, Customer', '2 · the brief’s one critical requirement', C.warn],
      ['Map + satellite toggle', 'Dispatcher', '4 · mapping & track-and-trace depth', C.accent],
      ['Drill-down: breadcrumbs, speed, odometer', 'Dispatcher exception', '4 · mapping & track-and-trace depth', C.accent],
      ['Four HOS clocks + duty log', 'Driver A/B/C', '5 · HOS & regulatory logic', C.crit],
      ['Axle-weight line in the offer card', 'Driver A', '5 · pre-dispatch audit', C.crit],
      ['Decision log with runners-up', 'System', '3 · problem discovery & innovation', '#a78bfa'],
      ['Empty-kilometre chart, naive vs corridor', 'System', '1, 3 · dollars and innovation', '#a78bfa'],
      ['Feed ticker', 'Dispatcher', '6 · simulation engine & real-time sync', '#7d8ea8'],
      ['Editable vs read-only split', 'Admin', '7 · can it replace the fragmented tools', '#7d8ea8'],
    ]
    rows.forEach((row, i) => {
      const rx2 = x + 28 + (i % 2) * ((w - 56) / 2)
      const ry = y3 + 110 + Math.floor(i / 2) * 28
      circle(rx2 - 12, ry - 4, 3.5, row[3])
      t(rx2, ry, row[0], { size: 12.5, weight: 600, fill: C.text })
      t(rx2 + 330, ry, row[1], { size: 11.5, fill: C.dim })
      t(rx2 + 460, ry, row[2], { size: 11.5, fill: row[3] })
    })
    t(x + 28, y3 + h - 24, 'Parking and the road-conditions list are deliberately absent from the dispatcher front page: they reach that desk only inside a queue card.',
      { size: 11.5, fill: C.faint })
  })
}

/* ================= the page ================= */

const PAD = 150
const PH_W = PHONE.w + PHONE.bez * 2          // 416
const PH_H = PHONE.h + PHONE.bez * 2          // 870
const LP_W = LAPTOP.w + LAPTOP.bx * 2         // 1492
const LP_H = LAPTOP.h + LAPTOP.bt + LAPTOP.bb // 974
const LP_TOTAL = LP_H + 19                    // + base
const GAP_X = 96
const ROW_GAP = 190

const COL2 = PAD + LP_W + 120                 // right column, beside a laptop
const BOARD_W = COL2 + LP_W + PAD             // two laptops wide

const ROW_A = 340                             // driver phones
const ROW_B = ROW_A + PH_H + ROW_GAP          // dispatcher laptops
const ROW_C = ROW_B + LP_TOTAL + ROW_GAP      // system + customer + spec
const ROW_D = ROW_C + LP_TOTAL + ROW_GAP      // admin + notes
const BOARD_H = ROW_D + LP_TOTAL + PAD

push(`<rect x="0" y="0" width="${BOARD_W}" height="${BOARD_H}" fill="${C.canvas}"/>`)

g('board header', () => {
  t(PAD, 108, 'Gladiolus Corridor', { size: 44, weight: 700, fill: C.text, ls: -1.2 })
  t(PAD + tw('Gladiolus Corridor', 44, { weight: 700 }) + 22, 108, 'portal designs', {
    size: 44, weight: 400, fill: C.accent, ls: -1.2,
  })
  t(PAD, 142, 'Every surface in plan.md on one page. Driver in phone chrome; dispatcher, system and admin on a laptop; the customer link is a phone because it arrives as a text message.',
    { size: 15, fill: C.muted })
  t(PAD, 168, 'City Dispatch / Regional Freight — Highway 401, Windsor → Scarborough · dark only · generated from src/styles.css tokens by design/board.mjs',
    { size: 12.5, mono: true, fill: C.faint })

  const bx = BOARD_W - PAD - 470
  panel(bx, 62, 470, 116, { rx: 10, fill: '#0d1119' })
  t(bx + 20, 88, 'ONE RULE DECIDES EVERY LAYOUT BELOW', {
    size: 10, weight: 700, ls: 1.3, fill: C.accent,
  })
  t(bx + 20, 114, 'Each portal answers exactly one question.', {
    size: 16, weight: 600, fill: C.text,
  })
  t(bx + 20, 138, 'A widget that does not serve its portal’s question belongs', {
    size: 12, fill: C.muted,
  })
  t(bx + 20, 155, 'on a different portal, however interesting it is.', { size: 12, fill: C.muted })
})

/* --- 01 driver --- */
caption(PAD, ROW_A - 48, '01', 'DRIVER',
  '“What do I do right now?”',
  'iPhone 390 × 844 · one truck, one screen · the emphasis moves with the driver’s state')

phone(PAD, ROW_A, 'Driver — A · rolling', driverA)
phone(PAD + PH_W + GAP_X, ROW_A, 'Driver — B · at a dock', driverB)
phone(PAD + (PH_W + GAP_X) * 2, ROW_A, 'Driver — C · clock low', driverC)

driverNotes(PAD + (PH_W + GAP_X) * 3, ROW_A, BOARD_W - PAD - (PAD + (PH_W + GAP_X) * 3), PH_H)

;[
  ['A · ROLLING', 'The load leads. Accept / Reject is a real veto,', 'and the compliance gate ran before the offer.'],
  ['B · AT A DOCK', 'The detention clock leads — it is the driver’s', 'leverage while they can still escalate.'],
  ['C · CLOCK LOW', 'Parking takes the top and the load card drops.', 'Never blank the screen because the news is bad.'],
].forEach((s, i) => {
  const sx = PAD + (PH_W + GAP_X) * i
  g(`driver state note ${i + 1}`, () => {
    t(sx, ROW_A + PH_H + 30, s[0], { size: 11, weight: 700, ls: 1.2, fill: C.accent })
    t(sx, ROW_A + PH_H + 50, s[1], { size: 12.5, fill: C.muted })
    t(sx, ROW_A + PH_H + 67, s[2], { size: 12.5, fill: C.muted })
  })
})

/* --- 02 dispatcher --- */
caption(PAD, ROW_B - 48, '02', 'DISPATCHER',
  '“What needs a human?”',
  'Laptop 1440 × 900 · the screen should be mostly empty — a full queue means the automation failed')

laptop(PAD, ROW_B, 'Dispatcher — calm (queue 0)', dispatcherCalm)
laptop(COL2, ROW_B, 'Dispatcher — exception (queue 1)', dispatcherException)

g('dispatcher notes', () => {
  t(PAD, ROW_B + LP_TOTAL + 30, 'DEFAULT · NOTHING NEEDS YOU', {
    size: 11, weight: 700, ls: 1.2, fill: C.ok,
  })
  t(PAD, ROW_B + LP_TOTAL + 50, 'This inverts every legacy TMS, and it is the first thing to show a judge. Parking and the 49-row road-conditions list are',
    { size: 12.5, fill: C.muted })
  t(PAD, ROW_B + LP_TOTAL + 67, 'deliberately gone from the front page — they stay in the engine and reach this desk only inside a queue card.',
    { size: 12.5, fill: C.muted })
  t(COL2, ROW_B + LP_TOTAL + 30, 'EXCEPTION · ONLY THE LEFT COLUMN CHANGES', {
    size: 11, weight: 700, ls: 1.2, fill: C.crit,
  })
  t(COL2, ROW_B + LP_TOTAL + 50, 'Same shell, one card. Satellite is on because the dispatcher is inspecting yard access; breadcrumbs and the speed trace are',
    { size: 12.5, fill: C.muted })
  t(COL2, ROW_B + LP_TOTAL + 67, 'folds over pings we already store, and they live one click from a truck rather than crowding the front page.',
    { size: 12.5, fill: C.muted })
})

/* --- 03 system + 05 customer + spec --- */
caption(PAD, ROW_C - 48, '03', 'SYSTEM',
  '“What did the automation decide, and why?”',
  'Laptop 1440 × 900 · the engine’s own console — an automation nobody can audit is one nobody will adopt')

laptop(PAD, ROW_C, 'System', systemPortal)

caption(COL2, ROW_C - 48, '05', 'CUSTOMER LINK',
  '“Where is my freight?”',
  'iPhone 390 × 844 · read-only, one load, no sign-in')

phone(COL2, ROW_C, 'Customer link', customerPortal)

specSheet(COL2 + PH_W + GAP_X, ROW_C, BOARD_W - PAD - (COL2 + PH_W + GAP_X), LP_TOTAL - 47)

g('system note', () => {
  t(PAD, ROW_C + LP_TOTAL + 30, 'THE DECISION LOG IS THE POINT', {
    size: 11, weight: 700, ls: 1.2, fill: C.warn,
  })
  t(PAD, ROW_C + LP_TOTAL + 50, '“Why did truck 118 get that load” has an answer on screen instead of in someone’s head. planAssignments already computes the losing',
    { size: 12.5, fill: C.muted })
  t(PAD, ROW_C + LP_TOTAL + 67, 'candidates on its way to the winner — it just has to stop throwing them away. The policy toggle lives here, not on a dispatcher’s shift.',
    { size: 12.5, fill: C.muted })
  t(COL2, ROW_C + PH_H + 30, 'SHOW THEM THEIR OWN CLOCK', {
    size: 11, weight: 700, ls: 1.2, fill: C.crit,
  })
  t(COL2, ROW_C + PH_H + 50, 'It is their dock causing it and their invoice at', { size: 12.5, fill: C.muted })
  t(COL2, ROW_C + PH_H + 67, 'the end. A live counter turns a month-end billing', { size: 12.5, fill: C.muted })
  t(COL2, ROW_C + PH_H + 84, 'dispute into a fact both sides watched happen.', { size: 12.5, fill: C.muted })
})

/* --- 04 admin + notes --- */
caption(PAD, ROW_D - 48, '04', 'ADMIN',
  '“What is this system configured to be?”',
  'Laptop 1440 × 900 · sits above dispatch rather than beside it — nothing here dispatches anything')

laptop(PAD, ROW_D, 'Admin', adminPortal)
annotations(COL2, ROW_D, LP_W)

g('admin note', () => {
  t(PAD, ROW_D + LP_TOTAL + 30, 'EDITABLE: COMMERCIAL TERMS WE CHOSE.  READ-ONLY: LAW, PHYSICS, OR A STATED ASSUMPTION.', {
    size: 11, weight: 700, ls: 1.2, fill: C.accent,
  })
  t(PAD, ROW_D + LP_TOTAL + 50, 'A console that offered the read-only inputs anyway would be lying about what it controls — so every field says which of the two it is, inline.',
    { size: 12.5, fill: C.muted })
  t(PAD, ROW_D + LP_TOTAL + 67, 'Every administrator action is appended to the same event log, so the audit trail costs a fold rather than a table.',
    { size: 12.5, fill: C.muted })
})

/* ---------- write ---------- */

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${BOARD_W}" height="${BOARD_H}" viewBox="0 0 ${BOARD_W} ${BOARD_H}" fill="none">`,
  `<title>Gladiolus Corridor — portal designs</title>`,
  ...out,
  '</svg>',
].join('\n')

writeFileSync(new URL('./corridor-portals.svg', import.meta.url), svg)
console.log(`corridor-portals.svg  ${BOARD_W} x ${BOARD_H}  ${(svg.length / 1024).toFixed(0)} KB  ${out.length} nodes`)
