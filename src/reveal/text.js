/** Text-index helpers over a container's joined text, ported from chat-reveal's reveal-text.ts. */

/** The first text entry ending after an offset; empty text nodes hold no range. */
export function revealEntryAt(entries, offset) {
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

/** Read only the entries intersecting this text interval. */
export function revealTextSlice(entries, from, to) {
  let text = ''
  for (let index = revealEntryAt(entries, from); index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry.start >= to) break
    text += entry.data.slice(
      Math.max(from, entry.start) - entry.start,
      Math.min(to, entry.start + entry.data.length) - entry.start,
    )
  }
  return text
}

/**
 * Reuse the text index only when every record preserves its prefix and structure.
 * The caller consumes the old length before replacing the shared tail entry.
 *
 * This is the append fast path: a streamed batch usually touches the last text
 * node's data and nothing else, so the whole index survives instead of being
 * rebuilt by a TreeWalker over the message.
 */
export function appendRevealSnapshot(previous, records) {
  if (previous === undefined || records === undefined || records.length === 0) return null
  const index = previous.entries.length - 1
  const tail = previous.entries[index]
  if (tail === undefined) return null
  for (const record of records) {
    if (record.type !== 'characterData' || record.target !== tail.node) return null
  }
  const data = tail.node.data
  if (!data.startsWith(tail.data)) return null
  previous.entries[index] = { node: tail.node, start: tail.start, data }
  return { length: tail.start + data.length, entries: previous.entries }
}
