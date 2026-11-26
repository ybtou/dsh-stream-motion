/**
 * The two curves the follow reads. `GLIDE_EASE` is the one the slide travels
 * on; evaluating it needs the same points the browser paints with, so a
 * carried distance and the animation never disagree.
 */
const KEYWORD_CURVES = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
}

const CURVES = new Map()

function parseCurve(easing) {
  const value = easing.trim()
  const held = CURVES.get(value)
  if (held !== undefined) return held
  const keyword = KEYWORD_CURVES[value]
  if (keyword !== undefined) {
    CURVES.set(value, keyword)
    return keyword
  }
  const match = /^cubic-bezier\(([^)]+)\)$/.exec(value)
  const parts = match === null ? [] : match[1].split(',').map((part) => Number(part.trim()))
  if (parts.length !== 4 || !parts.every(Number.isFinite)) {
    throw new Error(`ease: "${value}" has no control points to evaluate`)
  }
  CURVES.set(value, parts)
  return parts
}

function bezierAt(t, first, second) {
  const rest = 1 - t
  return 3 * rest * rest * t * first + 3 * rest * t * t * second + t * t * t
}

/** Evaluate a CSS easing string (`linear`, keyword or `cubic-bezier(...)`) at `progress`. */
export function easeValueAt(easing, progress) {
  if (progress <= 0) return 0
  if (progress >= 1) return 1
  const value = easing.trim()
  if (value === 'linear') return progress
  const [x1, y1, x2, y2] = parseCurve(value)
  let low = 0
  let high = 1
  // 24 halvings put the answer within a ten-millionth, past what a pixel of
  // any of these travels can show, at a fixed cost.
  for (let step = 0; step < 24; step += 1) {
    const middle = (low + high) / 2
    if (bezierAt(middle, x1, x2) < progress) low = middle
    else high = middle
  }
  return bezierAt((low + high) / 2, y1, y2)
}
