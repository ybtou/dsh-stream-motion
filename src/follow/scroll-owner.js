import { subscribeMutations } from '../bus.js'
import {
  CHAT_RUNNING_SELECTOR,
  COMPOSER_SELECTOR,
  CONVERSATION_SCROLL_SELECTOR,
  FOLLOW_THRESHOLD_PX,
  PROCESS_BODY_SELECTOR,
  PROCESS_RELEASE_THRESHOLD_PX,
  READER_HOLD_ATTR,
  SCROLL_EASE_LEAD_PX,
  SCROLL_KEYS,
  SIDEBAR_SLOT_SELECTOR,
  STREAMING_SELECTOR,
  SUBMISSION_HOLD_MS,
  FOLLOW_LOOK_ROUNDS,
  FOLLOW_LOOK_INTERVAL_MS,
  INTENT_TYPES,
  MOVING_INTENT_TYPES,
  TAIL_PRESS_CURVE,
  TAIL_PRESS_LOOK_ROUNDS,
  TAIL_PRESS_MAX_MS,
  TAIL_PRESS_MIN_MS,
  TAIL_PRESS_MS_PER_ROOT_PX,
  TOUCH_END_TYPES,
  UPWARD_SCROLL_KEYS,
} from './params.js'
import { SUBMISSION_ROW_SELECTOR, conversationScroller, findFollowTailButton, isScrollbarStrip } from './chat-dom.js'
import {
  easeScroll,
  easeScrollTimed,
  isScrollEasing,
  scrollEasePosition,
  scrollEnd,
  stopAllScrollEases,
  stopScrollEase,
} from './scroll-ease.js'
import { conversationSession } from '../session.js'

/**
 * The chat area's scroll positions have one writer: features ask, this module
 * decides on the spring of scroll-ease.js. Sources rank
 * jump > fold > reader > composer > follow > process; a request below the ease
 * running is refused, and composer, follow and process are refused while the
 * reader holds the container. The reader source is his own position held under
 * a stream's growth.
 *
 * While content streams nothing here writes: the host's follow pins the end,
 * and the follow feature slides what the pin pushed up. The reader's own wheel
 * stays the browser's and is only recorded, so the following sources stand
 * down; the scroller above a held container carries READER_HOLD_ATTR for the
 * waiting line's pin.
 */

export { SCROLL_EASE_LEAD_PX }

/** Each source's rank; a higher rank's claim stands over a lower one's. */
const SCROLL_SOURCE_RANK = {
  process: 1,
  follow: 2,
  composer: 3,
  reader: 4,
  fold: 5,
  jump: 6,
}

/** The sources that only follow the end: the reader holding a container stops them. */
const FOLLOWING_SOURCES = new Set(['composer', 'follow', 'process'])

/** Subtrees whose mutations are streaming tokens or sidebar chrome, never a user submission row. */
const NON_SUBMISSION_SUBTREE = `${SIDEBAR_SLOT_SELECTOR}, ${STREAMING_SELECTOR}, ${CHAT_RUNNING_SELECTOR}`

/** Whether an event is the reader taking the scroll over: a pointer or key inside the composer is him typing, and of the keys only the ones that scroll the viewport count. */
function isReaderScrollIntent(event) {
  const target = event.target
  if (target instanceof Element && target.closest(COMPOSER_SELECTOR) !== null) return false
  if (event.type !== 'keydown') return true
  return typeof KeyboardEvent !== 'undefined' && event instanceof KeyboardEvent && SCROLL_KEYS.has(event.key)
}

/** The source of the ease running on each container, stale once the spring has let go. */
const easeSources = new WeakMap()
/** The containers the reader holds. A Set, so leaving the owner can take every mark off again. */
const held = new Set()
/** The position the reader chose on each held container; host writes to the tail never replace it. */
const readerPositions = new WeakMap()
/** Increments when a held container's position changes away from its tail. */
const readerRevisions = new WeakMap()
let nextReaderRevision = 1
/** The scroll range when readerPositions was last recorded, to tell a host growth pin from reader travel. */
const readerFloors = new WeakMap()
/** The held containers the reader has since moved toward the end of: his own way back to it. */
const heldTowardEnd = new WeakSet()
/** The conversation scrollers carrying the hold mark. */
const markedScrollers = new Set()
/** When the reader last made a moving intent, for movedSince. */
let lastMovingIntentAt = 0
/** The vertical reading the current touch drag last reported. */
let touchContactY = null
/** The container whose scrollbar strip is currently pressed. */
let scrollbarDrag = null

/** Whether an event is a touch contact. A browser with its touch events off defines no TouchEvent. */
function isTouchEvent(event) {
  return typeof TouchEvent !== 'undefined' && event instanceof TouchEvent
}

/** The contact's vertical reading, or null when the event carries none. */
function contactY(event) {
  const contact = event.changedTouches[0]
  return contact === undefined ? null : contact.clientY
}

/** Until this moment the stream slide stands down: the reader's own message just arrived. */
let submissionHoldUntil = 0
/** How many features use the owner; its listeners live while one does. */
let members = 0
/** Bumped when the owner's listeners go: work begun by one installation ends with it. */
let ownerGeneration = 0
let stopSubmissionWatch = null
let stopSessionWatch = null

/**
 * Drop the containers the page took away. A detached container never sends the
 * scroll that ends its hold, so an entry left in `held` would keep the whole
 * transcript under it reachable.
 */
function forgetDetached() {
  for (const container of [...held]) {
    if (container.isConnected) continue
    held.delete(container)
    readerPositions.delete(container)
    readerRevisions.delete(container)
    readerFloors.delete(container)
    heldTowardEnd.delete(container)
  }
  for (const scroller of [...markedScrollers]) {
    if (scroller.isConnected) continue
    scroller.removeAttribute(READER_HOLD_ATTR)
    markedScrollers.delete(scroller)
  }
}

/** Publish the hold on the container's conversation scroller, where the waiting line's pin hangs. */
function syncHoldMark(container) {
  forgetDetached()
  const scroller = container.closest(CONVERSATION_SCROLL_SELECTOR)
  if (scroller === null) return
  let anyHeld = false
  for (const candidate of held) {
    if (candidate === scroller || scroller.contains(candidate)) {
      anyHeld = true
      break
    }
  }
  if (anyHeld) {
    scroller.setAttribute(READER_HOLD_ATTR, '')
    markedScrollers.add(scroller)
    return
  }
  scroller.removeAttribute(READER_HOLD_ATTR)
  markedScrollers.delete(scroller)
}

function floorOf(container) {
  return Math.max(0, container.scrollHeight - container.clientHeight)
}

/** Put a container's hold down or take it up with the mark the page reads; every change goes through here. */
function setHeld(container, holding) {
  if (holding === held.has(container)) return
  if (holding) {
    held.add(container)
    readerPositions.set(container, container.scrollTop)
    readerRevisions.set(container, nextReaderRevision)
    nextReaderRevision += 1
    readerFloors.set(container, floorOf(container))
  } else {
    held.delete(container)
    readerPositions.delete(container)
    readerRevisions.delete(container)
    readerFloors.delete(container)
    heldTowardEnd.delete(container)
  }
  syncHoldMark(container)
}

/** The ease running on a container now, and the source it serves. */
function runningSource(container) {
  if (!isScrollEasing(container)) {
    easeSources.delete(container)
    return undefined
  }
  return easeSources.get(container)
}

/** Whether `source` may move `container` now. */
function claim(container, source) {
  claimConversation()
  const running = runningSource(container)
  if (running !== undefined && SCROLL_SOURCE_RANK[source] < SCROLL_SOURCE_RANK[running]) return false
  if (FOLLOWING_SOURCES.has(source) && readerHolds(container)) return false
  return true
}

/** The reader's chosen position, or null while that container is not held. */
export function readerScrollPosition(container) {
  return readerPositions.get(container) ?? null
}

/** The held position's revision: a growth consumer can tell new travel from an old record. */
export function readerScrollRevision(container) {
  return readerRevisions.get(container) ?? 0
}

/**
 * Whether a tail reading on the container came from the host pinning new growth
 * rather than the reader travelling to the end: the floor grew while the
 * reader's last recorded position still sat beyond the release band.
 */
function isHostGrowthPin(container, floor, threshold) {
  if (scrollbarDrag === container || floor - container.scrollTop > 0.5) return false
  const prevTop = readerPositions.get(container)
  const prevFloor = readerFloors.get(container)
  return prevTop !== undefined
    && prevFloor !== undefined
    && floor > prevFloor + 0.5
    && prevFloor - prevTop > threshold
}

export function readerHolds(container) {
  if (!held.has(container)) return false
  // Only a move toward the end can end a hold, so a hold without one is
  // answered without reading the position: every following source asks on
  // every frame it runs, and a reading taken after the host's writes is a
  // layout pass over the whole page.
  if (!heldTowardEnd.has(container)) return true
  const threshold = container.matches(PROCESS_BODY_SELECTOR) ? PROCESS_RELEASE_THRESHOLD_PX : FOLLOW_THRESHOLD_PX
  const floor = floorOf(container)
  if (floor - container.scrollTop > threshold) return true
  if (isHostGrowthPin(container, floor, threshold)) {
    heldTowardEnd.delete(container)
    readerFloors.set(container, floor)
    return true
  }
  setHeld(container, false)
  return false
}

/** End the reader's hold on a container that no longer shows its own position (a folded body). */
export function releaseReader(container) {
  setHeld(container, false)
}

/**
 * Settle a hold the reader's drag has carried back to the end, and hand the
 * conversation's follow back with it.
 */
function releaseAtTail(container) {
  if (readerHolds(container)) return
  if (!container.matches(CONVERSATION_SCROLL_SELECTOR)) return
  const generation = ownerGeneration
  handBackFollow({ stillWanted: () => generation === ownerGeneration && !held.has(container) })
}

/**
 * Take the reader's hold on a container without an intent event: a jump to a
 * turn he picked is him choosing where to read.
 */
export function holdReader(container) {
  heldTowardEnd.delete(container)
  setHeld(container, true)
}

/** Whether the reader made a moving intent anywhere after `since`. */
export function readerMovedSince(since) {
  return lastMovingIntentAt > since
}

/** Whether the stream slide stands down for the reader's own message right now. */
export function submissionHolds() {
  return performance.now() < submissionHoldUntil
}

/** Per session: the id last claimed; a session switch releases its holds. */
let sessionId = null

/** Per-session holds, gestures and submission pauses end even while old DOM stays mounted. */
function releaseSession() {
  ownerGeneration += 1
  submissionHoldUntil = 0
  touchContactY = null
  stopAllScrollEases()
  for (const container of held) {
    readerPositions.delete(container)
    readerRevisions.delete(container)
    readerFloors.delete(container)
    heldTowardEnd.delete(container)
  }
  held.clear()
  if (scrollbarDrag !== null) endScrollbarDrag()
  for (const scroller of markedScrollers) scroller.removeAttribute(READER_HOLD_ATTR)
  markedScrollers.clear()
}

/**
 * Note which conversation the owner is working in, and drop what belonged to
 * the previous one.
 */
function claimConversation() {
  const next = conversationSession()
  if (next === sessionId) return
  sessionId = next
  releaseSession()
}

/**
 * Whether an intent is the reader's move in the conversation: inside its
 * scroller, or a key pressed with nothing else focused.
 */
function intentReaches(scroller, event) {
  const target = event.target
  if (event.type === 'keydown') {
    return target === document.body || target === document.documentElement || (target instanceof Node && scroller.contains(target))
  }
  return target instanceof Node && scroller.contains(target)
}

/**
 * Whether an event is the reader asking for the conversation's end through the
 * host's back-to-end button.
 */
function answersFollowTail(event, target) {
  if (!(target instanceof Element) || target.closest('button') === null) return false
  const button = findFollowTailButton()
  if (button === null || !button.contains(target)) return false
  if (event.type === 'click') return true
  if (event.type === 'pointerdown') return typeof PointerEvent === 'undefined' || !(event instanceof PointerEvent) || event.button === 0
  if (event.type === 'touchstart') return true
  return typeof KeyboardEvent !== 'undefined' && event instanceof KeyboardEvent && (event.key === 'Enter' || event.key === ' ')
}

/**
 * Set while this package presses the button itself. That press is the hand-back's
 * own, and its jump is wanted: the position has already been walked to the end,
 * so the write lands where it stands. Taking it would start the walk again.
 */
let pressingTail = false

/**
 * The host's back-to-end button jumps: its own handler calls the viewport's
 * follow, which writes the end in a single frame. The reader asked to go to the
 * end, not to be teleported there, so the press is taken here — the host's
 * handler never runs — and the position is travelled to the end on a timed ease.
 * Once it arrives the button is pressed for real, which is what turns the host's
 * follow back on.
 *
 * A timed ease rather than the spring, because this travel has a shape the
 * reader is meant to see: it takes off from rest, runs, and settles flush on the
 * end. A spring approaches its target asymptotically — the last few pixels crawl
 * — and its `lead` would close a far destination to the last 1200 px, moving the
 * reader a screenful in the first frame. The duration is read off the distance,
 * so a short trip is quick and a long one is not a wait.
 */
function noteTailPress(event) {
  if (pressingTail) return
  const target = event.target
  if (!answersFollowTail(event, target)) return
  const scroller = conversationScroller()
  if (scroller === null) return
  // The press is the reader's own move toward the end: whatever hold he had on
  // the conversation ends here, not at the arrival.
  releaseReader(scroller)
  if (motionReduced()) return
  // The host's own handler is the jump this replaces.
  event.preventDefault()
  event.stopImmediatePropagation()
  const generation = ownerGeneration
  const wanted = () => generation === ownerGeneration && !held.has(scroller)
  const distance = Math.abs(scrollEnd(scroller) - scroller.scrollTop)
  const duration = Math.max(TAIL_PRESS_MIN_MS, Math.min(TAIL_PRESS_MAX_MS, Math.sqrt(distance) * TAIL_PRESS_MS_PER_ROOT_PX))
  easeScrollTimed(scroller, (_element, end) => end, wanted, {
    duration,
    curve: TAIL_PRESS_CURVE,
    onArrive: () => handBackFollow({ stillWanted: wanted, rounds: TAIL_PRESS_LOOK_ROUNDS }),
  })
}

function noteIntent(event) {
  const target = event.target
  // A press or tap on the host's back-to-end button is the reader's own move
  // toward the end, and it ends the hold here rather than at the arrival: the
  // host's jump is the write that brings the position to the end, and growth
  // landing between the press and that jump reads as the host pinning the end,
  // which keeps a hold alive and lets the follow feature put the held position
  // back on the next growth.
  if (answersFollowTail(event, target)) {
    const scroller = conversationScroller()
    if (scroller !== null) releaseReader(scroller)
    return
  }
  if (!isReaderScrollIntent(event)) return
  const moving = MOVING_INTENT_TYPES.has(event.type)
  if (moving) lastMovingIntentAt = performance.now()
  // The finger left the screen: the drag it ends is aimed already, so this
  // settles holds and takes no new one.
  if (TOUCH_END_TYPES.has(event.type)) {
    touchContactY = null
    for (const container of [...held]) releaseAtTail(container)
    return
  }
  // Direction follows the gesture itself: wheel delta, scroll key polarity, or
  // actual scroll travel under a scrollbar drag.
  let towardEnd = true
  if (typeof WheelEvent !== 'undefined' && event instanceof WheelEvent) towardEnd = event.deltaY >= 0
  else if (typeof KeyboardEvent !== 'undefined' && event instanceof KeyboardEvent) {
    towardEnd = !(UPWARD_SCROLL_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey))
  } else if (event.type === 'pointerdown' || event.type === 'beforematch') towardEnd = false

  let touchAim = null
  if (isTouchEvent(event)) {
    const y = contactY(event)
    if (event.type === 'touchstart') {
      touchContactY = y
      towardEnd = false
    } else if (y !== null) {
      if (touchContactY !== null && y !== touchContactY) touchAim = y < touchContactY
      touchContactY = y
    }
  }
  const isScrollPointer = (container) => event.type !== 'pointerdown'
    || (typeof PointerEvent !== 'undefined' && event instanceof PointerEvent
      && (isScrollbarStrip(container, event, target) || event.button === 1))

  if (event.type !== 'touchmove') {
    const scroller = conversationScroller()
    claimConversation()
    if (scroller !== null && intentReaches(scroller, event) && isScrollPointer(scroller)
      && scroller.scrollHeight - scroller.clientHeight > 0) {
      if (event.type === 'pointerdown') beginScrollbarDrag(scroller)
      if (moving) {
        if (towardEnd) {
          heldTowardEnd.add(scroller)
          readerFloors.set(scroller, floorOf(scroller))
        } else {
          heldTowardEnd.delete(scroller)
        }
      }
      setHeld(scroller, true)
    }
  } else if (touchAim !== null) {
    const scroller = conversationScroller()
    claimConversation()
    if (scroller !== null && held.has(scroller)) {
      if (touchAim) heldTowardEnd.add(scroller)
      else heldTowardEnd.delete(scroller)
    }
  }
  if (event.type === 'beforematch') return
  if (!(target instanceof Element)) return
  const body = target.closest(PROCESS_BODY_SELECTOR)
  if (body === null) return
  if (!isScrollPointer(body)) return
  if (event.type === 'keydown' && event.defaultPrevented) return
  if (event.type === 'pointerdown') beginScrollbarDrag(body)
  if (moving) {
    if (towardEnd) {
      heldTowardEnd.add(body)
      readerFloors.set(body, floorOf(body))
    } else {
      heldTowardEnd.delete(body)
    }
  } else if (touchAim !== null && held.has(body)) {
    if (touchAim) heldTowardEnd.add(body)
    else heldTowardEnd.delete(body)
  }
  setHeld(body, true)
}

function endScrollbarDrag() {
  const dragged = scrollbarDrag
  scrollbarDrag = null
  document.removeEventListener('pointerup', endScrollbarDrag, true)
  document.removeEventListener('pointercancel', endScrollbarDrag, true)
  window.removeEventListener('blur', endScrollbarDrag)
  if (dragged !== null && held.has(dragged)) releaseAtTail(dragged)
}

function beginScrollbarDrag(container) {
  scrollbarDrag = container
  document.addEventListener('pointerup', endScrollbarDrag, true)
  document.addEventListener('pointercancel', endScrollbarDrag, true)
  window.addEventListener('blur', endScrollbarDrag)
}

/**
 * Release a held container as it comes back to its end, before growth can move
 * the end away again, and hand a released conversation back to the host's follow.
 */
function noteScroll(event) {
  const target = event.target
  if (!(target instanceof Element) || !held.has(target)) return
  const floor = floorOf(target)
  const prevTop = readerPositions.get(target)
  if (scrollbarDrag === target && prevTop !== undefined) {
    if (target.scrollTop > prevTop + 0.5) heldTowardEnd.add(target)
    else if (target.scrollTop < prevTop - 0.5) heldTowardEnd.delete(target)
  }
  const threshold = target.matches(PROCESS_BODY_SELECTOR) ? PROCESS_RELEASE_THRESHOLD_PX : FOLLOW_THRESHOLD_PX
  const hostGrowthPin = isHostGrowthPin(target, floor, threshold)
  if (floor - target.scrollTop > 0.5) {
    if (prevTop !== target.scrollTop) {
      readerRevisions.set(target, nextReaderRevision)
      nextReaderRevision += 1
    }
    readerPositions.set(target, target.scrollTop)
    readerFloors.set(target, floor)
  }
  if (!hostGrowthPin) releaseAtTail(target)
}

function hasSubmissionNode(nodes) {
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]
    if (node instanceof Element
      && (node.matches(SUBMISSION_ROW_SELECTOR) || node.querySelector(SUBMISSION_ROW_SELECTOR) !== null)) {
      return true
    }
  }
  return false
}

function noteSubmission(records) {
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    if (record.addedNodes.length === 0 && record.removedNodes.length === 0) continue
    if (record.target instanceof Element && record.target.closest(NON_SUBMISSION_SUBTREE) !== null) continue
    if (hasSubmissionNode(record.addedNodes) || hasSubmissionNode(record.removedNodes)) {
      submissionHoldUntil = performance.now() + SUBMISSION_HOLD_MS
      return
    }
  }
}

/**
 * Use the owner while a feature is installed: its intent, scroll and submission
 * watches live while any feature does.
 */
export function joinScrollOwner() {
  members += 1
  if (members === 1) {
    sessionId = conversationSession()
    stopSessionWatch = subscribeMutations(document.body, {
      beforePaint: true,
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-phase', 'data-conversation-session'],
    }, () => claimConversation())
    for (const type of INTENT_TYPES) document.addEventListener(type, noteIntent, { capture: true, passive: true })
    // The tail press has to be able to take the host's own handler out of the
    // way, and a passive listener may not call preventDefault.
    document.addEventListener('click', noteTailPress, { capture: true })
    window.addEventListener('scroll', noteScroll, { capture: true, passive: true })
    stopSubmissionWatch = subscribeMutations(document.body, { childList: true, subtree: true }, noteSubmission)
  }
  let left = false
  return () => {
    if (left) return
    left = true
    members -= 1
    if (members > 0) return
    for (const type of INTENT_TYPES) document.removeEventListener(type, noteIntent, true)
    document.removeEventListener('click', noteTailPress, true)
    window.removeEventListener('scroll', noteScroll, true)
    if (stopSubmissionWatch !== null) stopSubmissionWatch()
    stopSubmissionWatch = null
    if (stopSessionWatch !== null) stopSessionWatch()
    stopSessionWatch = null
    releaseSession()
    sessionId = null
  }
}

/** Put a container's position down now. */
export function writeScroll(container, value, source) {
  if (!claim(container, source)) return false
  const running = runningSource(container)
  if (running !== undefined && SCROLL_SOURCE_RANK[running] < SCROLL_SOURCE_RANK[source]) stopScrollEase(container)
  container.scrollTop = value
  return true
}

/**
 * Walk a container's position toward a destination on the spring, replacing the
 * ease running there.
 */
export function easeScrollFor(container, source, destination, wanted, lead = SCROLL_EASE_LEAD_PX) {
  if (!claim(container, source)) return false
  if (motionReduced()) {
    stopScrollEase(container)
    container.scrollTop = destination(container, scrollEnd(container))
    return true
  }
  const following = FOLLOWING_SOURCES.has(source)
  easeScroll(container, destination, () => wanted() && !(following && readerHolds(container)), lead)
  easeSources.set(container, source)
  return true
}

/** Walk a container's position to its end, wherever the end goes. */
export function easeScrollToEndFor(container, source, wanted) {
  return easeScrollFor(container, source, (_element, end) => end, wanted)
}

/** End the ease running on a container, when it serves `source` (or whichever source, without one). */
export function stopScrollFor(container, source) {
  const running = runningSource(container)
  if (running === undefined) return
  if (source !== undefined && running !== source) return
  stopScrollEase(container)
  easeSources.delete(container)
}

/** The position the ease last wrote on a container, or null while none runs there. */
export function scrollPositionFor(container) {
  return scrollEasePosition(container)
}

/**
 * Hand the conversation back to the host's own follow, lighting it up again
 * when it is off. The host turns its follow off on any write inside its 500 ms
 * sampling window and leaves one way back: the back-to-end button it renders
 * only while off. The hand-back stands the follow up from the end the reader is
 * already at.
 *
 * @param options.rounds - how many looks to spend; the press that walks the
 * position to the end needs more than the guard's five, because the ease runs
 * while it waits.
 */
export function handBackFollow(options) {
  const generation = ownerGeneration
  const stillWanted = () => generation === ownerGeneration && (options?.stillWanted?.() ?? true)
  const onSettled = options?.onSettled ?? null
  const roundsLimit = options?.rounds ?? FOLLOW_LOOK_ROUNDS
  const scroller = conversationScroller()
  if (scroller === null) {
    if (onSettled !== null) onSettled()
    return
  }
  // A position above the end is where the reader reads, and the end standing
  // above it is no sign of a follow that fell behind.
  if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 0.5) {
    if (onSettled !== null) onSettled()
    return
  }
  let rounds = 0
  const look = () => {
    if (!stillWanted() || rounds >= roundsLimit) {
      if (onSettled !== null) onSettled()
      return
    }
    rounds += 1
    // A position still easing is not one to press over: the host's own jump
    // would drop the ease before its curve had carried the position anywhere.
    if (isScrollEasing(scroller)) {
      window.setTimeout(look, FOLLOW_LOOK_INTERVAL_MS)
      return
    }
    // A pinned position does not mean the follow is back: the settlement may
    // switch it off a beat later, and after that only the button brings it
    // back. The button stands on the page only while the follow is off, so
    // finding one is the reading.
    const button = findFollowTailButton()
    if (button !== null) {
      // This press is the hand-back's own: the position already stands at the
      // end, and what the press is for is turning the host's follow back on. It
      // must not be taken as a reader's press, which would start the walk again.
      pressingTail = true
      try {
        button.click()
      } finally {
        pressingTail = false
      }
      if (onSettled !== null) onSettled()
      return
    }
    window.setTimeout(look, FOLLOW_LOOK_INTERVAL_MS)
  }
  window.setTimeout(look, FOLLOW_LOOK_INTERVAL_MS)
}

/** Whether the reader asked for reduced motion, read off the page's own mirror. */
let motionReduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Hand the motion preference over before the owner is joined. */
export function adoptMotionReduced(read) {
  motionReduced = read
}
