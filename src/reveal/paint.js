/**
 * The frame loop, ported from chat-reveal's reveal-paint.ts.
 *
 * Every live segment is repainted at its age's step. The engine's timestamps
 * live in the state object so the scanner and this loop share one clock.
 */

import { requestFrame } from '../frame.js'
import { revealEntryAt } from './text.js'
import {
  CHAT_REVEAL_FRAME_GAP_MS,
  CHAT_REVEAL_HIDDEN_GAP_MS,
  CHAT_REVEAL_MS,
  CHAT_REVEAL_NOMINAL_FRAME_MS,
  CHAT_REVEAL_SLOW_FRAME_MS,
  CHAT_REVEAL_SLOW_FRAME_RUN,
  CHAT_REVEAL_STEPS,
  CHAT_REVEAL_YIELD_MS,
} from './params.js'

/**
 * @param state - the engine's state; this module owns its frame timestamps.
 * @param hooks - the step table and the colour publisher.
 * @returns paint(now, fromFrame).
 */
export function createRevealPainter(state, hooks) {
  const { clearHighlights, publishRunColor, showStep } = hooks

  /**
   * What each step's highlight held after the last frame. A run spends
   * CHAT_REVEAL_MS / CHAT_REVEAL_STEPS on one step — thirty milliseconds, longer
   * than a frame — so on roughly every other frame a step's segments are the
   * same ones the browser is already drawing. Handing them over again makes it
   * rebuild the highlight markers for that step, which is the expensive half of
   * a frame here; leaving an unchanged step alone costs one comparison.
   */
  let painted = null

  const forgetPainted = () => {
    painted = null
  }

  /** Same text nodes, same offsets: the browser would draw exactly what it is drawing. */
  const sameSegments = (before, after) => {
    if (before === undefined || before === null) return after.length === 0
    if (before.length !== after.length) return false
    for (let index = 0; index < before.length; index += 1) {
      const one = before[index]
      const two = after[index]
      if (one.node !== two.node || one.start !== two.start || one.end !== two.end) return false
    }
    return true
  }

  /**
   * The main thread is full: the segments in hand are settled, and new
   * characters arrive at full strength for a while. The fade would not paint
   * smoothly anyway — every step would sit for tens of milliseconds — and its
   * per-frame work stacks on top of whatever is already slow. The text still
   * arrives; it just skips the fade.
   */
  const revealYield = () => {
    state.yieldUntil = performance.now() + CHAT_REVEAL_YIELD_MS
    state.slowFrames = 0
    state.lastFrameAt = 0
    state.liveRuns.length = 0
    forgetPainted()
    clearHighlights()
  }

  const scheduleFrame = () => {
    state.cancelPaintFrame = requestFrame({
      write(now) { paint(now, true) },
    })
  }

  /**
   * @param now - this frame's timestamp.
   * @param fromFrame - called by a paint frame rather than by the synchronous
   *     repaint a scan does: only these gaps say whether the main thread is busy.
   */
  const paint = (now, fromFrame) => {
    state.cancelPaintFrame = null
    if (state.liveRuns.length === 0) {
      forgetPainted()
      clearHighlights()
      return
    }

    // No frame was drawn in a long gap — a hidden page stops rAF, and a busy
    // main thread skips frames while performance.now() keeps running. The
    // undrawn stretch is subtracted from every segment's age so they continue
    // their own fade after the page comes back, rather than all expiring at once.
    const previousFrameAt = state.lastFrameAt
    state.lastFrameAt = now
    const gap = previousFrameAt === 0 ? 0 : now - previousFrameAt
    if (fromFrame && gap > CHAT_REVEAL_SLOW_FRAME_MS && gap < CHAT_REVEAL_HIDDEN_GAP_MS) state.slowFrames += 1
    else if (fromFrame && gap > 0) state.slowFrames = 0
    if (state.slowFrames >= CHAT_REVEAL_SLOW_FRAME_RUN) {
      revealYield()
      return
    }
    if (gap > CHAT_REVEAL_FRAME_GAP_MS) {
      const unspent = gap - CHAT_REVEAL_NOMINAL_FRAME_MS
      for (const run of state.liveRuns) {
        // Segments born in the blank count as born now, or they would wait that
        // same blank out before starting to fade. One the arrival clock queued
        // ahead of now keeps its place: pulling it back to now would flatten the
        // order the clock set and let a later character outrun an earlier one.
        const startedAt = run.bornAt
        run.bornAt = startedAt <= previousFrameAt ? startedAt + unspent : Math.max(startedAt, now)
      }
    }

    /** The segment each step has already drawn this frame; a following segment that touches it is merged in. */
    const drawn = new Array(CHAT_REVEAL_STEPS).fill(null)
    const buckets = []
    for (let step = 0; step < CHAT_REVEAL_STEPS; step += 1) buckets.push([])
    /** Live segments are compacted in place: splice would move every later element, and a batch of thousands is quadratic. */
    let kept = 0
    for (let index = 0; index < state.liveRuns.length; index += 1) {
      const run = state.liveRuns[index]
      if (run === undefined) continue
      const age = now - run.bornAt
      // Done: it is as solid as the text around it and needs no highlight.
      if (age >= CHAT_REVEAL_MS) continue
      state.liveRuns[kept] = run
      kept += 1
      // The scans that queued these segments built the snapshots on their way,
      // and every mutation after that goes through a fresh scan before this
      // frame, so the cache holds what is on screen. Walking the container again
      // here would put an O(whole message) TreeWalker into every frame.
      const snapshot = state.textSnapshots.get(run.container)
      if (snapshot === undefined) continue

      // The first text node that can hold this segment, found by binary search
      // over the snapshot: character-by-character segments mean many lookups a
      // frame, and scanning from the message's start is too slow.
      const end = run.start + run.length
      const firstIndex = revealEntryAt(snapshot.entries, run.start)
      const firstEntry = snapshot.entries[firstIndex]
      if (firstEntry === undefined) continue
      if (firstEntry.start >= end) continue
      const start = Math.max(0, run.start - firstEntry.start)
      let lastNode = firstEntry.node
      let lastEnd = Math.min(firstEntry.node.data.length, end - firstEntry.start)
      for (let next = firstIndex + 1; next < snapshot.entries.length; next += 1) {
        const entry = snapshot.entries[next]
        if (entry === undefined) break
        if (entry.start >= end) break
        lastNode = entry.node
        lastEnd = Math.min(entry.node.data.length, end - entry.start)
      }

      // The element comes from the text node the segment is in, not from the
      // one the scan saw: the markdown layer rebuilds nodes while a message
      // streams, and once the element a segment lived in is replaced the colour
      // written on the old one paints nothing — a flash of body colour instead
      // of a fade. The colour is read only when the element really changed,
      // because publishRunColor's first step is getComputedStyle, a forced style
      // resolution, and a few hundred of those a frame would drag the page's
      // whole style recalc into rAF.
      const element = firstEntry.node.parentElement
      if (element !== run.colorElement) {
        publishRunColor(element)
        run.colorElement = element
      }

      // The step: 0 is faintest, the last is the element's own colour; the
      // mapping is linear in time, so the colour settles at a constant rate.
      const step = age <= 0 ? 0 : Math.floor((age / CHAT_REVEAL_MS) * CHAT_REVEAL_STEPS)
      const bucket = buckets[step]
      if (bucket === undefined) continue
      // Adjacent characters in one text node at one step are the same stretch
      // of text this frame, so one segment holds them: the segment count drops
      // from characters to stretches.
      const previous = drawn[step] ?? null
      if (previous !== null && lastNode === firstEntry.node && previous.node === firstEntry.node && previous.end === start) {
        previous.end = lastEnd
        continue
      }
      const segment = { node: firstEntry.node, start, end: lastEnd }
      drawn[step] = segment
      bucket.push(segment)
    }
    state.liveRuns.length = kept

    const nextPainted = new Array(CHAT_REVEAL_STEPS).fill(null)
    for (let step = 0; step < CHAT_REVEAL_STEPS; step += 1) {
      const list = buckets[step] ?? []
      const before = painted === null ? null : painted[step]
      if (sameSegments(before, list)) {
        nextPainted[step] = before
        continue
      }
      // A StaticRange does not track DOM changes, and every frame builds them
      // from the fresh snapshot, so tracking is not needed; a live Range would
      // have the page fix its boundaries on every DOM change until collected.
      const ranges = list.map(segment => new StaticRange({
        startContainer: segment.node,
        startOffset: segment.start,
        endContainer: segment.node,
        endOffset: segment.end,
      }))
      showStep(step, ranges)
      nextPainted[step] = list
    }
    painted = nextPainted
    if (state.liveRuns.length > 0) scheduleFrame()
    else {
      forgetPainted()
      clearHighlights()
    }
  }

  /**
   * The registry can be emptied from outside this loop — a session broadcast
   * deletes every step — and a remembered frame would then claim a step is
   * already drawn when nothing is. The engine calls this wherever it clears.
   */
  paint.forget = forgetPainted

  return paint
}
