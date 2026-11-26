/**
 * The browser half: both features' stylesheets, their body gates, and the
 * engines themselves.
 *
 * This file is bundled into the factory the host's module loader calls. The
 * factory must have no side effects, so everything is registered inside
 * `apply` and its cleanup is returned through `ctx.effect`.
 *
 * The two halves stand independently. A browser without the Custom Highlight API
 * gets the smooth scroll and no fade; a browser without `Element.prototype.animate`
 * gets the fade and the host's own follow. Only a browser missing both leaves
 * nothing behind, and then nothing is marked.
 */

import { FOLLOW_ATTR, PACKAGE_NAME, REVEAL_ATTR, STYLE_ID } from './params.js'
import { mountStyle } from './stylesheet.js'
import { createEngine } from './reveal/engine.js'
import { stepRules } from './reveal/steps.js'
import { installFollow } from './follow/follow.js'
import { adoptMotionReduced, submissionHolds } from './follow/scroll-owner.js'
import { motionReduced } from './motion.js'

/** The capped body's clip, the host button's placement, and the reveal's step rules, in one sheet. */
function stylesheet() {
  return `
/* ---------- the capped process group's body ---------- */
/* The catch-up in follow/process-follow.js measures scrollHeight minus
   clientHeight, and the host declares only overflow-y on this body. By the CSS
   Overflow rules a visible axis beside a non-visible one computes to auto, so
   content a couple of pixels too wide (a wide table, an inline-flex atom,
   scrollbar-gutter's rounding) grows a horizontal scrollbar and adds its
   thickness to that difference. Clipped rather than scrollable: what can scroll
   sideways inside a group (code blocks, tables) carries its own overflow-x. */
body[${FOLLOW_ATTR}] [data-step-process]:not([data-group-expanded-mode]) [data-step-process-body] {
  overflow-x: hidden;
}
/* The host's own "back to the end" button, which it renders while its follow is
   off: outside the composer's top-right corner, where the reader is looking,
   instead of centred in the column's right gutter. Its two numbers are written
   per pass (follow/follow.js) from the composer's own edges: the button is fixed
   and the composer moves as a draft wraps and as the sidebars take width. */
body[${FOLLOW_ATTR}] [data-dsh-stream-motion-tail] {
  position: fixed !important;
  right: var(--dsh-stream-motion-tail-right) !important;
  bottom: var(--dsh-stream-motion-tail-bottom) !important;
  left: auto !important;
  top: auto !important;
  margin: 0 !important;
  transform: none !important;
  z-index: 8 !important;
}

/* ---------- the reveal's step rules ---------- */
${stepRules()}
`
}

export function apply(ctx) {
  const fade = createEngine()
  const slide = typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function'
  // Neither half can run: leave nothing behind, so the page looks exactly as it
  // would without this plugin.
  if (fade === null && !slide) return undefined

  const releaseStyle = mountStyle(STYLE_ID, stylesheet(), PACKAGE_NAME)
  const releases = []
  if (slide) {
    adoptMotionReduced(motionReduced)
    document.body.setAttribute(FOLLOW_ATTR, '')
    releases.push(installFollow({
      // A fold glide is another package's business; with none installed nothing
      // is ever gliding, and the guard reads that as "no wait".
      foldBusy: () => false,
      // The reader's own message taking its place is read off the scroll owner:
      // a submission row arriving inside the host's sampling window stands the
      // slide down.
      submissionHeld: submissionHolds,
      motionReduced,
    }))
  }
  if (fade !== null) {
    document.body.setAttribute(REVEAL_ATTR, '')
    releases.push(fade)
  }

  return ctx.effect(() => () => {
    for (const release of releases.reverse()) release()
    document.body.removeAttribute(FOLLOW_ATTR)
    document.body.removeAttribute(REVEAL_ATTR)
    releaseStyle()
  }, 'dsh-stream-motion: fade and follow')
}
