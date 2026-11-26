/**
 * The scanner, ported from chat-reveal's reveal-diff.ts.
 *
 * Compares the streaming containers against their last snapshots and queues the
 * characters that just appeared. The three stabilising ideas are unchanged:
 *
 * 1. A batch that only appends to the last text node reuses the whole index
 *    (`appendRevealSnapshot`), so a streamed character costs nothing structural.
 * 2. A batch that rewrites text keeps the common prefix and suffix in place and
 *    diffs only the middle, so folding a thinking row — which swaps text at the
 *    front while the answer keeps streaming at the back — does not freeze or
 *    snap the characters that did not move.
 * 3. Every queued segment is placed on one arrival clock shared across
 *    containers, so a later batch can never read brighter than an earlier one.
 */

import { appendRevealSnapshot, revealTextSlice } from './text.js'
import {
  CHAT_REVEAL_ACTIVE_LIMIT,
  CHAT_REVEAL_BURST_LIMIT,
  CHAT_REVEAL_FIRST_SIGHT_LIMIT,
  CHAT_REVEAL_LOCAL_REWRITE_LIMIT,
  CHAT_REVEAL_MAX_STAGGER_MS,
  CHAT_REVEAL_MIN_STAGGER_MS,
  CHAT_REVEAL_MS,
  CHAT_REVEAL_REWRITE_DIFF_BUDGET,
  CHAT_REVEAL_STAGGER_DIVISOR,
  STREAMING_SELECTOR,
} from './params.js'

/** The longest common prefix of two strings, by UTF-16 unit. */
function commonHead(left, right) {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1
  return index
}

/** The longest common suffix of two strings, by UTF-16 unit. */
function commonTail(left, right) {
  const leftLength = left.length
  const rightLength = right.length
  const limit = Math.min(leftLength, rightLength)
  let index = 0
  while (index < limit && left.charCodeAt(leftLength - 1 - index) === right.charCodeAt(rightLength - 1 - index)) index += 1
  return index
}

/**
 * How many characters the new index shares with the old one at its front, read
 * off the nodes rather than the joined text: a node that kept its place and its
 * text carries unchanged characters, and only the one or two nodes a batch
 * really touched are compared character by character.
 */
function commonPrefix(previous, entries) {
  if (previous === undefined) return 0
  const oldEntries = previous.entries
  let limit = Math.min(oldEntries.length, entries.length)
  let offset = 0
  for (let index = 0; index < limit; index += 1) {
    const before = oldEntries[index]
    const after = entries[index]
    if (before === undefined || after === undefined) return offset
    if (before.node !== after.node) return offset
    if (before.data === after.data) {
      offset += before.data.length
      continue
    }
    return offset + commonHead(before.data, after.data)
  }
  // Every shared node matched; the shorter side's end is the prefix.
  return offset
}

/** How many characters the new index shares with the old one at its back. */
function commonSuffix(previous, entries, prefix) {
  if (previous === undefined) return 0
  const oldEntries = previous.entries
  let oldIndex = oldEntries.length - 1
  let newIndex = entries.length - 1
  let offset = 0
  while (oldIndex >= 0 && newIndex >= 0) {
    const before = oldEntries[oldIndex]
    const after = entries[newIndex]
    if (before === undefined || after === undefined) break
    if (before.node !== after.node) break
    if (before.data === after.data) {
      offset += before.data.length
      oldIndex -= 1
      newIndex -= 1
      continue
    }
    const shared = commonTail(before.data, after.data)
    offset += shared
    break
  }
  // The prefix and the suffix must not overlap.
  const oldLength = previous.length
  return Math.min(offset, Math.max(0, oldLength - prefix))
}

/**
 * @param state - the engine's state.
 * @param hooks - publishRunColor, paint, and an optional `accepts` filter over containers.
 * @returns scan(only, changes): `only` limits the look to the containers this
 *     batch touched, null looks at every container on the page and drops the
 *     ones that are gone.
 */
export function createRevealScanner(state, hooks) {
  const { paint, publishRunColor } = hooks
  const accepts = hooks.accepts ?? (() => true)

  return (only, changes) => {
    const now = performance.now()
    let containers
    if (only === null) {
      containers = [...document.querySelectorAll(STREAMING_SELECTOR)].filter(accepts)
      // Containers no longer streaming lose their snapshots and their segments:
      // a snapshot holds the message's text nodes, so a finished answer would
      // otherwise stay reachable through this engine for the rest of the session.
      const alive = new Set(containers)
      const vanished = new Set()
      for (const gone of state.liveContainers) {
        if (alive.has(gone)) continue
        state.textSnapshots.delete(gone)
        vanished.add(gone)
      }
      if (vanished.size > 0) {
        // Compacted in place, not spliced one removal at a time: a segment count
        // runs into the thousands, and a splice moves every later element.
        let kept = 0
        for (let index = 0; index < state.liveRuns.length; index += 1) {
          const run = state.liveRuns[index]
          if (run === undefined || vanished.has(run.container)) continue
          state.liveRuns[kept] = run
          kept += 1
        }
        state.liveRuns.length = kept
      }
      state.liveContainers = containers
    } else {
      containers = [...only].filter(container => container.isConnected && container.matches(STREAMING_SELECTOR) && accepts(container))
      for (const container of containers) if (!state.liveContainers.includes(container)) state.liveContainers.push(container)
    }

    if (state.baselinePending) {
      for (const container of containers) state.historyContainers.add(container)
      state.baselinePending = false
    }
    if (containers.length === 0) return

    /** The main thread is busy and the engine has given way: snapshots are still updated, the batch just does not fade. */
    const yielding = now < state.yieldUntil
    /** The segments this scan created, grouped so the stagger can be handed out per batch. */
    const createdRuns = []

    for (const container of containers) {
      const batchStart = createdRuns.length
      const previous = state.textSnapshots.get(container)
      const beforeLength = previous?.length ?? 0
      const appended = appendRevealSnapshot(previous, changes?.get(container))
      const entries = appended?.entries ?? []
      let length = appended?.length ?? 0
      if (appended === null) {
        // Structural changes rebuild the index; tail-only text mutations keep it.
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node !== null) {
          const data = node.data
          entries.push({ node, start: length, data })
          length += data.length
          node = walker.nextNode()
        }
      }
      state.textSnapshots.set(container, { length, entries })

      // The first sight of this container. One that was on the page when the
      // engine installed is history; one that appears already long (a session
      // switch, a page of history mounting) counts as history too. Only one that
      // appeared after install without much text — a new answer — has its
      // opening characters counted as new.
      if (previous === undefined && (state.historyContainers.has(container) || length > CHAT_REVEAL_FIRST_SIGHT_LIMIT)) continue

      const prefix = appended === null ? commonPrefix(previous, entries) : beforeLength
      const suffix = appended === null ? commonSuffix(previous, entries, prefix) : 0
      const stableFrom = beforeLength - suffix
      const shift = length - beforeLength
      if (appended === null) {
        let kept = 0
        for (let index = 0; index < state.liveRuns.length; index += 1) {
          const run = state.liveRuns[index]
          if (run === undefined) continue
          if (run.container !== container || run.start + run.length <= prefix) {
            state.liveRuns[kept] = run
            kept += 1
            continue
          }
          if (run.start >= stableFrom) {
            // Stable suffix segments move together and retain their age.
            state.liveRuns[kept] = { ...run, start: run.start + shift }
            kept += 1
          }
        }
        state.liveRuns.length = kept
      }

      if (yielding) continue

      // The reader just folded or unfolded something: this change came from that
      // reflow, not from the model emitting characters.
      const quietUntil = state.foldQuietUntil.get(container)
      if (quietUntil !== undefined && now <= quietUntil) continue

      // The characters that just appeared. On a plain append they are the
      // trailing stretch; when markdown closes a marker (** or a backtick or a
      // link) they sit inside the old text, and those characters should fade too.
      //
      // The middle is what the rewrite check looks at: strip the common prefix
      // and suffix from both sides, align what is left with one character-level
      // longest-common-subsequence pass, and the new characters are the ones
      // that do not match. A large middle is given up on — a whole-block rewrite
      // (the final re-layout at the end of a stream) must not make the reader
      // watch the fade again.
      const oldMiddleLength = beforeLength - prefix - suffix
      const newMiddleLength = length - prefix - suffix
      if (newMiddleLength === 0) continue
      const available = Math.max(0, CHAT_REVEAL_ACTIVE_LIMIT - state.liveRuns.length)
      if (oldMiddleLength === 0 && newMiddleLength > Math.min(CHAT_REVEAL_BURST_LIMIT, available)) continue
      if (oldMiddleLength > 0 && oldMiddleLength * newMiddleLength > CHAT_REVEAL_REWRITE_DIFF_BUDGET) continue
      const oldMiddle = oldMiddleLength === 0 || previous === undefined ? '' : revealTextSlice(previous.entries, prefix, stableFrom)
      const newMiddle = revealTextSlice(entries, prefix, length - suffix)

      // Whether each new character matches one in the old text. With an empty old
      // middle every character is new and no alignment is needed.
      const matched = new Uint8Array(newMiddle.length)
      if (oldMiddle.length > 0) {
        // A bottom-up common-subsequence length table, walked back to decide
        // which new characters match the old text.
        const columns = newMiddle.length + 1
        const lengths = new Uint16Array((oldMiddle.length + 1) * columns)
        for (let row = oldMiddle.length - 1; row >= 0; row -= 1) {
          for (let column = newMiddle.length - 1; column >= 0; column -= 1) {
            const same = oldMiddle.charCodeAt(row) === newMiddle.charCodeAt(column)
            lengths[row * columns + column] = same
              ? (lengths[(row + 1) * columns + column + 1] ?? 0) + 1
              : Math.max(lengths[(row + 1) * columns + column] ?? 0, lengths[row * columns + column + 1] ?? 0)
          }
        }
        let matchedCount = 0
        let row = 0
        let column = 0
        while (row < oldMiddle.length && column < newMiddle.length) {
          if (oldMiddle.charCodeAt(row) === newMiddle.charCodeAt(column)) {
            matched[column] = 1
            matchedCount += 1
            row += 1
            column += 1
            continue
          }
          const skipOldRow = lengths[(row + 1) * columns + column] ?? 0
          const skipNewColumn = lengths[row * columns + column + 1] ?? 0
          const advanceOldRow = skipOldRow >= skipNewColumn
          if (advanceOldRow) row += 1
          if (!advanceOldRow) column += 1
        }
        if (matchedCount === 0 || newMiddle.length - matchedCount > CHAT_REVEAL_LOCAL_REWRITE_LIMIT) continue
      }

      // The unmatched new characters are the batch; consecutive ones merge into
      // one stretch.
      const addedRanges = []
      let rangeStart = -1
      for (let index = 0; index < newMiddle.length; index += 1) {
        if (matched[index] === 1) {
          if (rangeStart >= 0) addedRanges.push({ start: rangeStart + prefix, end: index + prefix })
          rangeStart = -1
          continue
        }
        if (rangeStart < 0) rangeStart = index
      }
      if (rangeStart >= 0) addedRanges.push({ start: rangeStart + prefix, end: newMiddle.length + prefix })
      if (addedRanges.length === 0) continue
      // Too many characters at once do not fade: thousands together read as a
      // blur, and the segment count is the character count multiplied into every
      // frame (one Range per segment).
      let addedLength = 0
      for (const range of addedRanges) addedLength += range.end - range.start
      if (addedLength > Math.min(CHAT_REVEAL_BURST_LIMIT, available)) continue

      // The walk goes node by node rather than over the joined string: every
      // segment has to carry the element it renders in (that is where the step
      // rules read the colour from), and a node's text always renders in one
      // element. Characters inside one node are born together, and the stagger
      // is handed out by position after the walk — "the whole line lights up at
      // once" is exactly what the stagger spreads out. Iteration is by code
      // point, so a surrogate pair is one segment; whitespace takes no segment
      // of its own but still advances the offset.
      const touchedElements = new Set()
      for (const range of addedRanges) {
        for (let index = revealEntryIndex(entries, range.start); index < entries.length; index += 1) {
          const entry = entries[index]
          if (entry === undefined || entry.start >= range.end) break
          const begin = Math.max(range.start, entry.start)
          const end = Math.min(range.end, entry.start + entry.node.data.length)
          const element = entry.node.parentElement
          let offset = begin
          for (const character of entry.node.data.slice(begin - entry.start, end - entry.start)) {
            if (character.trim().length === 0) {
              offset += character.length
              continue
            }
            // One style read per element per scan: a batch of text usually lands
            // in one or two nodes, so even a whole paragraph arriving at once
            // costs a few reads.
            if (element !== null && !touchedElements.has(element)) {
              touchedElements.add(element)
              publishRunColor(element)
            }
            const run = {
              container,
              start: offset,
              length: character.length,
              // Placed on the arrival clock once the batch's step is known, below.
              bornAt: now,
              colorElement: element,
            }
            state.liveRuns.push(run)
            createdRuns.push(run)
            offset += character.length
          }
        }
      }

      // The batch is staggered by its characters' order in the stream: the whole
      // batch spreads over no more than one fade, so inserting several hundred
      // characters does not make the tail wait seconds. More characters means a
      // smaller step each, and the sweep stays continuous.
      //
      // The stagger is spent on the state's arrival clock rather than on this
      // batch's own start, so overlapping batches queue behind each other: two
      // containers streaming at once, or a second append landing inside the
      // first one's fade, keep their order and a character can never read
      // brighter than one before it.
      const batchCount = createdRuns.length - batchStart
      const staggerLimit = Math.min(CHAT_REVEAL_MAX_STAGGER_MS, Math.max(CHAT_REVEAL_MIN_STAGGER_MS, CHAT_REVEAL_MS / CHAT_REVEAL_STAGGER_DIVISOR))
      const step = batchCount <= 1 ? 0 : Math.min(staggerLimit, CHAT_REVEAL_MS / (batchCount - 1))
      // A character may wait at most one fade before its own fade starts: past
      // that the backlog is dropped rather than queued, since text sitting faint
      // while the stream runs ahead of it reads as a stuck answer. The cap closes
      // the queue instead of resetting the clock — a reset would put the arriving
      // batch ahead of the one still fading, the inversion this clock prevents.
      const latest = now + CHAT_REVEAL_MS
      let start = Math.max(now, state.cursor)
      for (let slot = batchStart; slot < createdRuns.length; slot += 1) {
        const run = createdRuns[slot]
        if (run === undefined) continue
        run.bornAt = Math.min(start, latest)
        start += step
      }
      state.cursor = Math.min(start, latest)
    }

    if (createdRuns.length === 0) return
    // A new character has to carry the faintest step within the same frame.
    // Scheduling a paint waits for the next rendering step, and this scan can run
    // right after this step's rAF phase — the character would then be painted at
    // full strength for one frame and pressed back to faint on the next, which
    // the eye reads as a flash. So it is painted synchronously.
    if (state.cancelPaintFrame !== null) {
      state.cancelPaintFrame()
      state.cancelPaintFrame = null
    }
    paint(performance.now(), false)
  }
}

/** The first entry ending after an offset, inlined to keep the scan's hot loop out of a module call. */
function revealEntryIndex(entries, offset) {
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const entry = entries[middle]
    if (entry.start + entry.data.length <= offset) low = middle + 1
    else high = middle
  }
  return low
}
