/**
 * One frame for every task: read, then scroll, then write, in that order.
 *
 * Requests made during a frame wait for the next one; cancelling removes the
 * task so a running frame skips its remaining phases; an error in one task is
 * isolated and does not take the frame down. Both features share this queue, so
 * a scroll frame and a paint frame run in the same pass and the page is laid out
 * once.
 */

/** The tasks the next frame runs, in request order. */
let queued = []
/** The tasks still wanted: cancelling removes a task here, so a running frame skips it. */
const live = new Set()
let handle = 0

function reportError(error) {
  console.error('dsh-stream-motion: a frame task threw', error)
}

function runFrame(now) {
  handle = 0
  const tasks = queued
  queued = []
  for (const task of tasks) {
    if (task.read === undefined || !live.has(task)) continue
    try { task.read(now) } catch (error) { reportError(error) }
  }
  for (const task of tasks) {
    if (task.scroll === undefined || !live.has(task)) continue
    try { task.scroll(now) } catch (error) { reportError(error) }
  }
  for (const task of tasks) {
    if (!live.has(task)) continue
    live.delete(task)
    if (task.write === undefined) continue
    try { task.write(now) } catch (error) { reportError(error) }
  }
}

/** Queue for the next frame; the returned cancellation also skips the remaining phases of a running task. */
export function requestFrame(task) {
  if (live.has(task)) throw new Error('dsh-stream-motion: this frame task is already requested')
  live.add(task)
  queued.push(task)
  if (handle === 0) handle = requestAnimationFrame(runFrame)
  return () => {
    live.delete(task)
    const at = queued.indexOf(task)
    if (at !== -1) queued.splice(at, 1)
    if (queued.length === 0 && handle !== 0) {
      cancelAnimationFrame(handle)
      handle = 0
    }
  }
}
