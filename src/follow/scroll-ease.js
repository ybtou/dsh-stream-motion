import { requestFrame } from '../frame.js'
import { easeValueAt } from './ease.js'
import {
  EASE_DONE_PX,
  EASE_MAX_ACCEL_PX_S2,
  EASE_MAX_FRAME_MS,
  EASE_MAX_SPEED_PX_S,
  EASE_MOVED_PX,
  EASE_NOMINAL_FRAME_MS,
  EASE_OMEGA,
  EASE_REST_PX_S,
  EASE_STEP_S,
  SCROLL_EASE_LEAD_PX,
} from './params.js'

/**
 * The scroll motions this package draws. Only the scroll owner imports this
 * module; nothing else may.
 *
 * Two shapes, for two different jobs:
 *
 * - The **spring** is for a destination that moves. A critically damped spring
 *   treats a target that grew mid-flight as only a wider gap and never
 *   overshoots, which is what a catch-up on content still arriving needs.
 * - The **timed ease** is for a destination the reader named. Its progress is
 *   read off the clock rather than off the distance left, so the motion has a
 *   beginning, a middle and an end: it takes off from rest, reaches its fastest
 *   in the middle, and settles exactly on the target at the last frame. A spring
 *   cannot promise that last part — it approaches its target asymptotically, so
 *   the final pixels crawl.
 */

/** The elements easing now, each with its destination, its test and the motion it carries. */
const easing = new Map()
let frameQueued = false
let lastAt = 0

/** Carry a position and its speed toward a target through `seconds` of the spring, with both caps applied. */
export function stepSpring(position, velocity, target, seconds) {
  for (let spent = 0; spent < seconds; spent += EASE_STEP_S) {
    const step = Math.min(EASE_STEP_S, seconds - spent)
    let acceleration = EASE_OMEGA * EASE_OMEGA * (target - position) - 2 * EASE_OMEGA * velocity
    acceleration = Math.max(-EASE_MAX_ACCEL_PX_S2, Math.min(EASE_MAX_ACCEL_PX_S2, acceleration))
    // Semi-implicit Euler: the velocity steps first and the position follows
    // it, the order that keeps a stiff spring stable.
    velocity = Math.max(-EASE_MAX_SPEED_PX_S, Math.min(EASE_MAX_SPEED_PX_S, velocity + acceleration * step))
    position += velocity * step
  }
  return { position, velocity }
}

/** Whether a position has arrived: within half a pixel of the target and nearly still. */
export function springArrived(position, velocity, target) {
  return Math.abs(target - position) <= EASE_DONE_PX && Math.abs(velocity) <= EASE_REST_PX_S
}

/** A scroll container's end: the position that shows its last pixel. */
export function scrollEnd(element) {
  return element.scrollHeight - element.clientHeight
}

/** Start, or re-arm, the spring on one element. */
export function easeScroll(element, destination, wanted, lead = SCROLL_EASE_LEAD_PX) {
  // A re-arm while a run is in flight keeps its speed: zeroing it would redo
  // the take-off the spring exists to avoid.
  const active = easing.get(element)
  easing.set(element, {
    kind: 'spring',
    destination,
    wanted,
    lead,
    velocity: active !== undefined && active.kind === 'spring' ? active.velocity : 0,
    position: active === undefined ? null : active.position,
    // Carried across a re-arm like the velocity: a fresh reading would look
    // like someone else's move.
    lastWritten: active === undefined ? null : active.lastWritten,
  })
  schedule()
}

/**
 * Start a timed ease: from wherever the position stands now to the destination,
 * over `duration`, on `curve`, landing on the target exactly.
 *
 * The curve decides the shape. One whose control points start shallow, steepen,
 * then flatten again (`cubic-bezier(0.4, 0, 0.2, 1)`) reads as a push-off, a
 * run and a settle; one that starts steep is only a deceleration.
 *
 * @param options.duration - how long the whole travel takes, in milliseconds.
 * @param options.curve - a CSS easing string; `easeValueAt` evaluates it.
 * @param options.onArrive - called once, on the frame the target is written.
 */
export function easeScrollTimed(element, destination, wanted, options) {
  const now = performance.now()
  easing.set(element, {
    kind: 'timed',
    destination,
    wanted,
    from: element.scrollTop,
    startAt: now,
    duration: Math.max(1, options.duration),
    curve: options.curve,
    onArrive: options.onArrive ?? null,
    lastWritten: element.scrollTop,
  })
  schedule()
}

export function stopScrollEase(element) {
  easing.delete(element)
}

export function stopAllScrollEases() {
  for (const element of [...easing.keys()]) easing.delete(element)
}

export function isScrollEasing(element) {
  return easing.has(element)
}

/** The position the ease last wrote on this element, or null while it is not easing on it. */
export function scrollEasePosition(element) {
  const ease = easing.get(element)
  if (ease === undefined) return null
  return ease.kind === 'timed' ? ease.lastWritten : ease.lastWritten
}

function writeScrollEase(element, ease, value) {
  if (ease.kind === 'spring') ease.position = value
  element.scrollTop = value
  ease.lastWritten = element.scrollTop
  return ease.lastWritten
}

function schedule() {
  if (frameQueued) return
  lastAt = 0
  frameQueued = true
  requestFrame({ scroll: stepScrollEase })
}

/** One frame of the spring: read the distance left, carry the position through it. */
function stepSpringFrame(element, ease, seconds) {
  const floor = scrollEnd(element)
  const target = Math.max(0, Math.min(floor, ease.destination(element, floor)))
  // The fraction the ease keeps, unless someone else moved the position since
  // its last write: then the position is taken where it is.
  let position = ease.position
  if (position === null || ease.lastWritten === null || Math.abs(element.scrollTop - ease.lastWritten) > EASE_MOVED_PX) {
    position = element.scrollTop
  }
  // A far destination: closed to the lead first, on the side the position comes from.
  if (Math.abs(target - position) > ease.lead) {
    position = target - Math.sign(target - position) * ease.lead
  }
  const motion = stepSpring(position, ease.velocity, target, seconds)
  ease.velocity = motion.velocity
  const next = Math.max(0, Math.min(floor, motion.position))
  if (springArrived(next, motion.velocity, target)) {
    writeScrollEase(element, ease, target)
    return true
  }
  const written = writeScrollEase(element, ease, next)
  // A container can clamp the write a few pixels short of the arithmetic end
  // (clipped overflow, scrollbar rounding): it has arrived as far as it can, and
  // the loop must not keep waking for it.
  return Math.abs(written - next) > EASE_MOVED_PX
}

/**
 * One frame of the timed ease: the fraction comes off the clock, so the shape is
 * the curve's and the arrival is the last frame rather than an approach.
 */
function stepTimedFrame(element, ease, now) {
  const floor = scrollEnd(element)
  const target = Math.max(0, Math.min(floor, ease.destination(element, floor)))
  // Someone else moved the position since the last write: the travel restarts
  // from there rather than snapping back to where this ease began.
  if (ease.lastWritten !== null && Math.abs(element.scrollTop - ease.lastWritten) > EASE_MOVED_PX) {
    ease.from = element.scrollTop
    ease.startAt = now
    ease.lastWritten = element.scrollTop
  }
  const elapsed = now - ease.startAt
  const progress = elapsed / ease.duration
  if (progress >= 1) {
    // The last frame writes the target itself: the position lands flush instead
    // of stopping a fraction of a pixel short, which is what a curve evaluated
    // at t = 1 would do if the target moved during the travel.
    writeScrollEase(element, ease, target)
    return true
  }
  const eased = easeValueAt(ease.curve, progress)
  const next = Math.max(0, Math.min(floor, ease.from + (target - ease.from) * eased))
  writeScrollEase(element, ease, next)
  return false
}

function stepScrollEase(now) {
  frameQueued = false
  const interval = lastAt === 0
    ? EASE_NOMINAL_FRAME_MS
    : Math.min(EASE_MAX_FRAME_MS, Math.max(0, now - lastAt))
  lastAt = now
  const seconds = interval / 1000
  const arrived = []
  for (const [element, ease] of [...easing]) {
    // One container's callback throwing must not freeze the others' motion.
    try {
      // A container that left the document, or one the reader has taken over,
      // is done here: the loop never scrolls what nobody is following.
      if (!element.isConnected || !ease.wanted()) {
        easing.delete(element)
        continue
      }
      const done = ease.kind === 'timed'
        ? stepTimedFrame(element, ease, now)
        : stepSpringFrame(element, ease, seconds)
      if (!done) continue
      easing.delete(element)
      if (ease.kind === 'timed' && ease.onArrive !== null) arrived.push(ease.onArrive)
    } catch (error) {
      easing.delete(element)
      reportError(error)
    }
  }
  // Told after the whole batch has been written, so a callback that starts
  // another ease does not interleave with this frame's writes.
  for (const onArrive of arrived) {
    try { onArrive() } catch (error) { reportError(error) }
  }
  if (easing.size === 0) return
  schedule()
}
