/**
 * The page's own motion mirror: a page that says "reduced" or "full" wins, and
 * with neither the system preference answers. One reading, shared by both
 * halves — the fade stands down and the slide stands down on the same word.
 */

const MOTION_ATTR = 'data-dsh-stream-motion-motion'

export function motionReduced() {
  const resolved = document.body.getAttribute(MOTION_ATTR)
  if (resolved === 'reduced') return true
  if (resolved === 'full') return false
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}
