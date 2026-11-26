import { subscribeMutations } from '../bus.js'
import { requestFrame } from '../frame.js'
import {
  CHAT_FLOW_SELECTOR,
  CONVERSATION_SCROLL_SELECTOR,
  DISCLOSURE_HEADER_SELECTOR,
  DISCLOSURE_ROW_SELECTOR,
  FOLD_BUSY_GRACE_MS,
  FOLD_INTENT_TTL_MS,
  FOLD_POPUP_SELECTOR,
  FOLD_ROLL_MS,
  FOLD_SHUT_CONFIRM_FRAMES,
  FOLD_VISIBLE_SHARE,
  FOLLOW_THRESHOLD_PX,
  PROCESS_BODY_SELECTOR,
  PROCESS_EXPANDED_MODE_ATTRIBUTE,
} from './params.js'
import { handBackFollow, joinScrollOwner, readerMovedSince } from './scroll-owner.js'

/**
 * A door: the chevron on a thinking row, a tool row's header, a process group's
 * title. The host opens and closes them by inserting or hiding the body in the
 * same commit the click lands in, so without help the height under the reader
 * changes in one frame and everything below it jumps by that much.
 *
 * This module puts a height animation in front of that change. Closing is
 * intercepted while the body is still mounted, the body is rolled up, and the
 * click is replayed once it has landed; opening is let through, and the body is
 * rolled out from the height the root had while it was shut. Only a click inside
 * the chat flow counts, so the model picker, the settings dropdowns and the
 * sidebar keep their own instant behaviour.
 */

/** Margin past a roll's own duration for the backstop that unlocks the click. */
const ROLL_BACKSTOP_MS = 200
/** The frame interval a stall is measured against when nothing better is known. */
const NOMINAL_FRAME_MS = 16.7
/** A gap longer than this between frames is a stall, not a slow frame. */
const STALL_GAP_MS = 25

/** Until when the position belongs to a roll. */
let busyUntil = 0

/** Whether a roll owns the position right now. */
export function foldBusy() {
  return performance.now() < busyUntil
}

/** The visible part of an element through every clipping ancestor, in page pixels. */
function visibleReach(element) {
  const rect = element.getBoundingClientRect()
  let bottom = Math.min(rect.bottom, window.innerHeight)
  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor)
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
    bottom = Math.min(bottom, ancestor.getBoundingClientRect().bottom)
  }
  return Math.max(0, Math.min(rect.height, bottom - rect.top))
}

/** The control a press works: a disclosure row, or any element carrying aria-expanded. */
function controlAt(target) {
  const disclosure = target.closest(DISCLOSURE_ROW_SELECTOR)
  if (disclosure !== null) return disclosure
  const toggle = target.closest('[aria-expanded]')
  return toggle instanceof HTMLElement ? toggle : null
}

/** The body a control opens, by the id it names. */
function controlledBody(control) {
  const id = control.getAttribute('aria-controls')
  if (id === null) return null
  const body = document.getElementById(id)
  return body instanceof HTMLElement ? body : null
}

/**
 * The body a control has open right now.
 *
 * `aria-controls` is the host's explicit answer when it gives one. Otherwise the
 * body is the root's last element child that is not the header: the disclosure
 * shape puts the header first and the body after it, and a body that has not been
 * inserted yet simply is not there — which is how an opening press is told from a
 * closing one when the control carries no aria-controls.
 */
function openBody(control, root) {
  const named = controlledBody(control)
  if (named !== null) return named
  const disclosure = control.closest(DISCLOSURE_ROW_SELECTOR)
  const header = disclosure === null ? null : disclosure.closest(DISCLOSURE_HEADER_SELECTOR)
  const skip = header === null ? control.parentElement : header
  for (let node = root.lastElementChild; node !== null; node = node.previousElementSibling) {
    if (node === skip || node.contains(control)) continue
    return node
  }
  return null
}

/** The box whose height a door changes: a process group's root, else the row's own root. */
function foldRoot(control, body) {
  if (body !== null && body.matches(PROCESS_BODY_SELECTOR)) {
    const group = body.parentElement
    const root = group === null ? null : group.closest('[data-step-process]')
    return root instanceof HTMLElement ? root : null
  }
  const disclosure = control.closest(DISCLOSURE_ROW_SELECTOR)
  if (disclosure === null) return null
  const header = disclosure.closest(DISCLOSURE_HEADER_SELECTOR)
  const root = header === null ? disclosure.parentElement : header.parentElement
  return root instanceof HTMLElement ? root : null
}

/** The height the root comes to once the body is gone: what the header alone takes. */
function collapsedHeight(root, body) {
  if (body === null) return 0
  const full = root.getBoundingClientRect().height
  const bodyBox = body.getBoundingClientRect()
  const margin = parseFloat(getComputedStyle(body).marginTop) || 0
  return Math.max(0, full - bodyBox.height - margin)
}

/** Hold the target's box still while its height is animated over the real layout. */
function beginClip(target) {
  const overflow = target.style.overflow
  const boxSizing = target.style.boxSizing
  target.style.overflow = 'hidden'
  target.style.boxSizing = 'border-box'
  return () => {
    target.style.overflow = overflow
    target.style.boxSizing = boxSizing
  }
}

/** Whether the reader stands at the end, so the hand-back knows whether to follow. */
function atBottom(control) {
  const scroller = control.closest(CONVERSATION_SCROLL_SELECTOR)
  if (scroller === null) return false
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= FOLLOW_THRESHOLD_PX
}

/**
 * Install the door glide. Returns its teardown.
 */
export function createFoldGlide() {
  const leaveOwner = joinScrollOwner()
  /** An opening press, waiting for the host to insert the body it opens. */
  let intent = null
  /** A collapse is rolling: for its duration no new fold starts. */
  let shutting = false
  /** A press that arrived mid-roll, replayed once the roll lets go. */
  let queued = null
  /** The click being replayed to the host; that one must not be intercepted again. */
  let replaying = false
  let stopped = false
  /** Cancels the frame that waits for a collapse, and the one that rewinds a stall. */
  let cancelConfirm = null
  let cancelStall = null
  /** The timer that unlocks the click if the roll never finishes. */
  let backstop = null
  /** The hand-back waiting on the roll that just landed. */
  let stopSettle = null

  const replace = (current, next) => {
    if (current !== null) current()
    return next
  }

  /** Hand the follow back once the roll has landed, if the reader never left the end. */
  const settleAfter = (watch, animation) => {
    const hand = () => {
      if (stopped || !watch.atBottom || watch.moved()) return
      handBackFollow({ stillWanted: () => !stopped })
    }
    let done = false
    const settle = () => {
      if (done) return
      hand()
    }
    animation.finished.then(settle, settle)
    return () => {
      done = true
    }
  }

  /**
   * Keep the roll's clock honest through a main-thread stall: WAAPI advances
   * through a gap that painted nothing, and the follow behind it would resume
   * late. The gap is rewound by the last measured frame interval.
   */
  const holdThroughStalls = (animation) => {
    let lastFrameAt = 0
    let lastTime = 0
    let interval = NOMINAL_FRAME_MS
    let cancelled = false
    let cancelLook = null
    const timeOf = () => (typeof animation.currentTime === 'number' ? animation.currentTime : 0)
    const look = (now) => {
      cancelLook = null
      if (cancelled || animation.playState !== 'running') return
      const gap = lastFrameAt === 0 ? 0 : now - lastFrameAt
      if (gap > STALL_GAP_MS) {
        const resumeAt = lastTime + interval
        const skipped = timeOf() - resumeAt
        if (skipped > 0) {
          animation.currentTime = resumeAt
          busyUntil += skipped
        }
      } else if (gap > 0) {
        interval = gap
      }
      lastFrameAt = now
      lastTime = timeOf()
      cancelLook = requestFrame({ write: look })
    }
    cancelLook = requestFrame({ write: look })
    return () => {
      cancelled = true
      if (cancelLook !== null) cancelLook()
      cancelLook = null
    }
  }

  /**
   * Roll a root from one height to another.
   *
   * A box taller than the screen is rolled over its visible part first: paying
   * back the offscreen stretch at the same rate would race the text the reader is
   * watching past them.
   */
  const roll = (root, from, to) => {
    busyUntil = performance.now() + FOLD_ROLL_MS + FOLD_BUSY_GRACE_MS
    const reach = Math.max(from, visibleReach(root))
    const restore = beginClip(root)
    const frames = from > to
      ? [
          { height: `${from}px`, offset: 0, easing: 'linear' },
          { height: `${reach}px`, offset: 1 - FOLD_VISIBLE_SHARE, easing: 'ease-out' },
          { height: `${to}px`, offset: 1 },
        ]
      : [
          { height: `${from}px`, offset: 0, easing: 'ease-out' },
          { height: `${reach}px`, offset: FOLD_VISIBLE_SHARE, easing: 'linear' },
          { height: `${to}px`, offset: 1 },
        ]
    const animation = root.animate(frames, { duration: FOLD_ROLL_MS, easing: 'ease-out', fill: 'forwards' })
    cancelStall = replace(cancelStall, holdThroughStalls(animation))
    return { animation, restore }
  }

  /** Wait for the host to collapse the body, then drop the pinned height. */
  const confirmCollapsed = (settled, done) => {
    let cancelled = false
    let cancelLook = null
    let tries = 0
    const step = () => {
      cancelLook = null
      if (cancelled) return
      if (settled() || tries >= FOLD_SHUT_CONFIRM_FRAMES) {
        done()
        return
      }
      tries += 1
      cancelLook = requestFrame({ write: step })
    }
    step()
    return () => {
      cancelled = true
      if (cancelLook !== null) cancelLook()
      cancelLook = null
    }
  }

  /** The host has inserted the body an opening press was waiting for. */
  const flushIntent = () => {
    const current = intent
    if (current === null) return
    if (Date.now() - current.takenAt > FOLD_INTENT_TTL_MS) {
      intent = null
      return
    }
    const body = openBody(current.control, current.root)
    if (body === null || body.hasAttribute('hidden')) return
    if (!current.root.isConnected) {
      intent = null
      return
    }
    const full = current.root.getBoundingClientRect().height
    if (full <= current.from + 1) {
      intent = null
      return
    }
    intent = null
    const { animation, restore } = roll(current.root, current.from, full)
    animation.onfinish = () => {
      animation.cancel()
      restore()
    }
    stopSettle = replace(stopSettle, settleAfter(current.watch, animation))
  }

  const onClick = (event) => {
    if (stopped || replaying) return
    const target = event.target
    if (!(target instanceof Element)) return
    // Only the chat area is taken over: aria-expanded is used page-wide.
    if (target.closest(CHAT_FLOW_SELECTOR) === null) return
    // A menu or a dialog opens no folding body.
    if (target.closest(FOLD_POPUP_SELECTOR) !== null) return
    if (shutting) {
      queued = target
      event.stopPropagation()
      event.preventDefault()
      return
    }
    const control = controlAt(target)
    if (control === null) return
    const named = controlledBody(control)
    // A process group in expanded mode has no cap to roll.
    if (named !== null && named.closest(`[${PROCESS_EXPANDED_MODE_ATTRIBUTE}]`) !== null) return
    const root = foldRoot(control, named)
    if (root === null) return
    const body = openBody(control, root)
    const since = performance.now()
    const watch = { atBottom: atBottom(control), moved: () => readerMovedSince(since) }
    // Opening: the body is not there yet, so the height to start from is read
    // now, while the root is still shut.
    if (body === null || body.hasAttribute('hidden')) {
      intent = { control, root, from: root.getBoundingClientRect().height, watch, takenAt: Date.now() }
      return
    }
    // Closing: the body is still mounted, so it can be rolled up before the host
    // takes it away.
    const full = root.getBoundingClientRect().height
    const floor = collapsedHeight(root, body)
    if (full <= floor + 1) return
    event.stopPropagation()
    event.preventDefault()
    shutting = true
    const { animation, restore } = roll(root, full, floor)
    if (backstop !== null) window.clearTimeout(backstop)
    backstop = window.setTimeout(() => {
      backstop = null
      shutting = false
      flushQueued()
    }, FOLD_ROLL_MS + ROLL_BACKSTOP_MS)
    animation.onfinish = () => {
      if (backstop !== null) window.clearTimeout(backstop)
      backstop = null
      shutting = false
      replaying = true
      try {
        control.click()
      } finally {
        replaying = false
      }
      flushQueued()
      const settled = () => (body.matches(PROCESS_BODY_SELECTOR) ? body.hasAttribute('hidden') : !body.isConnected)
      cancelConfirm = replace(cancelConfirm, confirmCollapsed(settled, () => {
        animation.cancel()
        restore()
      }))
      stopSettle = replace(stopSettle, settleAfter(watch, animation))
    }
  }

  const flushQueued = () => {
    const target = queued
    queued = null
    if (!(target instanceof HTMLElement) || !target.isConnected) return
    if (shutting) {
      queued = target
      return
    }
    target.click()
  }

  document.addEventListener('click', onClick, true)
  // A process group folds with setAttribute('hidden', 'until-found'), an
  // attribute change alone, which a child-list subscription never hears.
  const stopWatch = subscribeMutations(
    document.body,
    { childList: true, subtree: true, attributeFilter: ['hidden'] },
    flushIntent,
  )

  return () => {
    stopped = true
    document.removeEventListener('click', onClick, true)
    stopWatch()
    if (cancelConfirm !== null) cancelConfirm()
    cancelConfirm = null
    if (cancelStall !== null) cancelStall()
    cancelStall = null
    if (stopSettle !== null) stopSettle()
    stopSettle = null
    if (backstop !== null) window.clearTimeout(backstop)
    backstop = null
    intent = null
    queued = null
    busyUntil = 0
    leaveOwner()
  }
}
