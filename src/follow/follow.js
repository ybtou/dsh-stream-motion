import { observeMarker, observeMatches, observeSize, subscribeMutations } from '../bus.js'
import { requestFrame } from '../frame.js'
import { easeValueAt } from './ease.js'
import {
  CHAT_CALL_SELECTOR,
  CHAT_RUNNING_SELECTOR,
  COMPOSER_CARD_SELECTOR,
  CONVERSATION_SCROLL_SELECTOR,
  DISCLOSURE_HEADER_SELECTOR,
  DISCLOSURE_ROW_SELECTOR,
  EXPANDED_ATTRIBUTE,
  FLOW_BLOCK_SELECTOR,
  FOLLOW_ACTIVITY_GRACE_MS,
  FOLLOW_HOLD_ATTR,
  FOLLOW_MIN_INTERVAL_MS,
  FOLLOW_TAIL_AIR_PX,
  FOLLOW_THRESHOLD_PX,
  FOLLOWING_TAIL_ATTRIBUTE,
  FOLLOWING_TAIL_SELECTOR,
  GLIDE_EASE,
  PROCESS_BODY_SELECTOR,
  PROCESS_EXPANDED_MODE_ATTRIBUTE,
  READER_HOLD_ATTR,
  ROW_PHASE_ATTRIBUTE,
  RUNNING_STATE,
  SHIMMER_SELECTOR,
  SLIDE_MS,
  STREAMING_SELECTOR,
  TAIL_ATTR,
  TAIL_BOTTOM_VAR,
  TAIL_RIGHT_VAR,
  THINK_ROW_SELECTOR,
} from './params.js'
import { conversationColumn, conversationScroller, findFollowTailButton } from './chat-dom.js'
import {
  SCROLL_EASE_LEAD_PX,
  handBackFollow,
  joinScrollOwner,
  readerHolds,
  readerScrollPosition,
  readerScrollRevision,
  writeScroll,
} from './scroll-owner.js'
import { createProcessFollow } from './process-follow.js'

/**
 * Enhanced follow and the capped process group's follow. Both ride one switch:
 * they are the two halves of the same hand-back.
 *
 * The guard that watches for the moments that lose the host's follow is below;
 * the hand-back itself and every position write are the scroll owner's; the
 * catch-up inside a capped body is in process-follow.js.
 */

/** One tool call's row, and one flow block, in one selector: a new node either way. */
export const FOLLOW_STRUCTURE_SELECTOR = `${FLOW_BLOCK_SELECTOR}, ${CHAT_CALL_SELECTOR}`
/** Content is streaming: the host writes both marks, and only then is there a follow to lose. */
export const FOLLOW_RUNNING_SELECTOR = `${STREAMING_SELECTOR}, ${SHIMMER_SELECTOR}`

/** A fold glide in flight is waited out; after this many waits the round is dropped. */
const FOLLOW_FOLD_WAIT_MS = 150
const FOLLOW_FOLD_WAIT_ATTEMPTS = 4

/** The conversation's own composer card: the lowest of the cards on the page. */
function conversationComposerCard(cards) {
  let found = null
  let lowest = -Infinity
  for (const card of cards) {
    const box = card.getBoundingClientRect()
    if (box.width === 0 && box.height === 0) continue
    if (box.top > lowest) {
      lowest = box.top
      found = card
    }
  }
  return found
}

/**
 * Where the host's back-to-end button stands this frame, as a read phase found
 * it: outside the composer's top-right corner.
 *
 * The host puts the button in the column's right gutter, centred over the
 * conversation. That is a long way from where the reader is looking — the end of
 * the text sits right above the composer they are typing in — and the two
 * numbers are measured rather than assumed because both edges move: the composer
 * grows as a draft wraps, and the sidebars take width from the column.
 */
function readTailPlacement(cards) {
  const button = findFollowTailButton()
  if (button === null) return null
  const card = conversationComposerCard(cards)
  if (card === null) return null
  const cardBox = card.getBoundingClientRect()
  return {
    button,
    // Anchored on the right edge, not on a centre: the button's own width then
    // never has to be known, and a host that restyles it still lands flush.
    right: `${Math.round(window.innerWidth - cardBox.right)}px`,
    bottom: `${Math.round(window.innerHeight - cardBox.top + FOLLOW_TAIL_AIR_PX)}px`,
  }
}

/** Put the button where the read phase measured it; the write phase's half. */
function writeTailPlacement(marked, placement) {
  if (placement === null) {
    if (marked !== null) marked.removeAttribute(TAIL_ATTR)
    return null
  }
  const { button, right, bottom } = placement
  if (marked !== null && marked !== button) marked.removeAttribute(TAIL_ATTR)
  if (!button.hasAttribute(TAIL_ATTR)) button.setAttribute(TAIL_ATTR, '')
  if (button.style.getPropertyValue(TAIL_RIGHT_VAR) !== right) button.style.setProperty(TAIL_RIGHT_VAR, right)
  if (button.style.getPropertyValue(TAIL_BOTTOM_VAR) !== bottom) button.style.setProperty(TAIL_BOTTOM_VAR, bottom)
  return button
}

/**
 * Watch the whole page for the moments that lose the host's follow, and hand the
 * position back at each of them; while content streams, slide what the host's
 * pin pushed up instead of letting it jump in one frame.
 *
 * @param options.foldBusy - whether a fold glide is animating a height right now.
 * @param options.submissionHeld - whether the reader's own message is still taking its place.
 * @param options.motionReduced - whether the page must hold its animations still.
 */
export function createFollowGuard(options) {
  const { foldBusy, submissionHeld, motionReduced } = options
  const leaveOwner = joinScrollOwner()
  /** When the last hand-back really landed, for the throttle. */
  let lastEnsureAt = 0
  /** When structure last changed, for the grace. */
  let lastActivityAt = 0
  let scanQueued = false
  /** Set by the teardown: no pass is queued and no retry is waiting. */
  let stopped = false
  /** Cancels the frame a seen moment waits on. */
  let cancelScan = null
  /** The wait a fold glide put the hand-back on, so the teardown can drop it. */
  let foldWaitTimer = null
  /** This batch of mutations held a structural moment / the follow being turned off. */
  let structureSeen = false
  let guardSeen = false
  let tailReadWanted = false

  /** Whether the reader is reading up there right now. */
  const readerAway = () => {
    const scroller = conversationScroller()
    return scroller !== null && readerHolds(scroller)
  }

  // ---------- the stream slide ----------
  //
  // While work is streaming and the reader is at the end, the host follows by
  // writing the end outright the moment content grows, so the text above the
  // last line would be pushed up in one frame on every burst. The host's write
  // stands; in the same frame, before it paints, the column is put back down by
  // the growth and slid to rest on the compositor. No position is written and no
  // layout is asked for: the host's follow stays on through the stream.
  /** The flow column the slide reads growth from. */
  let slideColumn = null
  /** Stops the slide's size subscription on slideColumn. */
  let stopSlideSize = null
  /** The column's height as the slide last saw it; the growth a frame is measured against. */
  let slideHeight = 0
  /** The scroller position after the previous resize batch; null until the first report. */
  let slideScrollTop = null
  /** The held position's revision at that batch: new travel alone may use the owner's absolute position. */
  let slideReaderRevision = 0
  /** Whether the current conversation column has ever stood at or followed the tail. */
  let seenAtTail = false
  /** The slide running now. */
  let slide = null
  /** The column the hold mark is on, or null while no door holds it. */
  let heldColumn = null
  /** Whether the size subscription's first report for the current column has been taken as its baseline. */
  let slideArmed = false
  /** When the last growth arrived, and the smoothed gap before it: the pace a slide is timed to. */
  let grewAt = 0
  let grewEvery = 0

  /**
   * The live turn's own row and thinking rows: the slide counter-slides both the
   * bottom waiting row and any top-stuck expanded thinking header so neither
   * jumps while the column glides.
   */
  const runningRows = observeMatches(CHAT_RUNNING_SELECTOR)
  const thinkRows = observeMatches(THINK_ROW_SELECTOR)

  /**
   * Whether content is arriving right now. It rides the newest block — the
   * answer the flow is writing — so the query starts from the end of the column;
   * a mark standing anywhere else is read off the bus's registry, which hears
   * the attribute arrive, so the transcript is never walked for it.
   */
  const runningMarks = observeMarker(FOLLOW_RUNNING_SELECTOR)
  const streaming = () => {
    const column = conversationColumn()
    if (column === null) return false
    let block = column.lastElementChild
    for (let at = 0; at < 3 && block !== null; at += 1, block = block.previousElementSibling) {
      // The mark can sit on the block itself (a host that marks the row) or on a
      // descendant (one that marks the answer inside it): both are this block
      // streaming.
      if (block.matches(FOLLOW_RUNNING_SELECTOR) || block.querySelector(FOLLOW_RUNNING_SELECTOR) !== null) return true
    }
    return runningMarks.all().some((mark) => column.contains(mark))
  }

  /** Whether work counts as in progress right now. */
  const running = () => streaming() || performance.now() - lastActivityAt <= FOLLOW_ACTIVITY_GRACE_MS

  /**
   * Whether this growth is slid. The gate is the streaming mark itself rather
   * than the guard's wider "work in progress" window: the structural moments
   * that window exists for are the hand-back's business.
   */
  const slideWanted = (column) => {
    if (motionReduced()) return false
    // The reader's own message is taking its place: the host's jump to it
    // stands, and an entrance measured against the row's own box would be moved
    // by a slide's offset.
    if (submissionHeld()) return false
    if (!streaming()) return false
    if (readerAway()) return false
    if (foldBusy()) return false
    // The host's own mark that it follows the end, an attribute read: without it
    // this frame's growth was not pinned, and sliding would move content that
    // never went up.
    return column.closest(FOLLOWING_TAIL_SELECTOR) !== null
  }

  /** End the running slide where it is: the column and its counter-slid elements land at rest together. */
  const stopSlide = () => {
    if (slide === null) return
    slide.column.cancel()
    for (const counter of slide.counters) counter.cancel()
    slide = null
  }

  /** Whether the conversation scroller currently stands at or follows its tail. */
  const noteTailIfNear = (scroller) => {
    if (seenAtTail || scroller === null) return
    if (scroller.querySelector(FOLLOWING_TAIL_SELECTOR) !== null
      || scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= FOLLOW_THRESHOLD_PX) {
      seenAtTail = true
    }
  }

  /** The distance the running slide still carries, off its own clock and curve: no style is read. */
  const slideCarried = () => {
    if (slide === null) return 0
    const startedAt = slide.column.startTime
    // An animation that has not begun — the frame it was made in has not
    // painted — still carries the whole distance; reading it as nothing would
    // drop that distance on the next restart.
    if (startedAt === null) return slide.from
    const linear = (Number(document.timeline.currentTime) - Number(startedAt)) / slide.duration
    if (!(linear > 0)) return slide.from
    if (linear >= 1) return 0
    // The curve the animation paints with, not the linear share of its duration:
    // with the two mixed up, every restart re-inflates the distance the frame
    // before it had already travelled.
    return slide.from * (1 - easeValueAt(GLIDE_EASE, linear))
  }

  /**
   * How long this slide may run. A piece of an answer arriving at a provider's
   * pace lands well inside the slide token, and a slide still moving when the
   * next piece lands starts its restart from a distance it had not paid back
   * yet: the column is drawn further below the tail with every piece until it
   * stands at the longest stretch a slide carries. The gap the last two pieces
   * kept is the time this one has before the next, so the slide is timed to
   * that; the token stays the ceiling for an answer slow enough for the glide to
   * settle between pieces.
   */
  const slideDuration = () => {
    if (grewEvery === 0) return SLIDE_MS
    return Math.min(SLIDE_MS, Math.max(grewEvery, 1))
  }

  /** Expanded thinking headers currently stuck against the outer scroller's top edge. */
  const stuckThinkHeaders = (column, scroller) => {
    if (scroller === null) return []
    const found = []
    let scrollerTop = null
    const all = thinkRows.all()
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const think = all[i]
      if (!think.hasAttribute(EXPANDED_ATTRIBUTE) || !column.contains(think)) continue
      // Inside a capped process body, the whole body glides as one box with the column.
      const processBody = think.closest(PROCESS_BODY_SELECTOR)
      if (processBody !== null && processBody.closest(`[${PROCESS_EXPANDED_MODE_ATTRIBUTE}]`) === null) continue
      const header = think.querySelector(DISCLOSURE_HEADER_SELECTOR)
        ?? think.querySelector(DISCLOSURE_ROW_SELECTOR)
      if (header === null || getComputedStyle(header).position !== 'sticky') continue
      if (scrollerTop === null) scrollerTop = scroller.getBoundingClientRect().top
      const rowRect = think.getBoundingClientRect()
      const headerRect = header.getBoundingClientRect()
      if (rowRect.top < scrollerTop - 0.5
        && rowRect.bottom > scrollerTop + headerRect.height + 0.5
        && Math.abs(headerRect.top - scrollerTop) <= 2) {
        found.push(header)
      }
    }
    return found
  }

  /**
   * Put the column back down by this frame's growth and slide it to rest.
   *
   * One replace-mode animation at a time: an additive one stays off the
   * compositor, so a new growth restarts from the distance still carried — up to
   * the longest stretch a slide carries, so a burst is glided as far as that and
   * no farther. Its length follows the pace the pieces arrive at, so the distance
   * carried never outgrows one piece. The live turn's row is pinned to the
   * scroller's bottom and would ride the column's offset, so it gets the same
   * slide reversed, started in the same frame: the two cancel and it stands.
   */
  const startSlide = (column, scroller, grew) => {
    const from = Math.min(SCROLL_EASE_LEAD_PX, slideCarried() + grew)
    stopSlide()
    const countersToAnimate = []
    const pinned = runningRows.all().find((row) => column.contains(row)) ?? null
    if (pinned !== null) countersToAnimate.push(pinned)
    for (const header of stuckThinkHeaders(column, scroller)) countersToAnimate.push(header)
    const duration = slideDuration()
    const timing = { duration, easing: GLIDE_EASE }
    const columnSlide = column.animate(
      [{ transform: `translateY(${from}px)` }, { transform: 'translateY(0px)' }],
      timing,
    )
    const counterFrames = [{ transform: `translateY(${-from}px)` }, { transform: 'translateY(0px)' }]
    const counters = countersToAnimate.map((element) => element.animate(counterFrames, timing))
    const current = { column: columnSlide, counters, from, duration }
    columnSlide.onfinish = () => {
      if (slide === current) slide = null
    }
    slide = current
  }

  /** Take the hold mark off the column carrying it. */
  const releaseHold = () => {
    if (heldColumn === null) return
    heldColumn.removeAttribute(FOLLOW_HOLD_ATTR)
    heldColumn = null
  }

  /**
   * Put the hold mark on the column while a door rolls. A door's height change
   * reads to the host as a reader who left the tail, so the host takes
   * data-chat-following-tail away; the mark keeps the pin standing until the
   * fold hands the follow back.
   */
  const markHold = (column) => {
    if (heldColumn === column) return
    releaseHold()
    column.setAttribute(FOLLOW_HOLD_ATTR, '')
    heldColumn = column
  }

  /**
   * Watch the flow column the slide reads growth from; a session switch replaces
   * it.
   *
   * The size subscription is made anew for every column, after the host's.
   * Resize observer callbacks run in the order the observers were made, and the
   * host makes the one it pins the end from when it mounts the column.
   * Subscribed `afterHost` once the column is there, this one runs after the pin
   * in the same frame and puts the column back down before it paints; one made at
   * install would run first, and every pin would paint.
   *
   * The column's height is not read here: this runs in the batch's own callback,
   * when the host has just mounted the whole tree, and an offsetHeight read
   * forces that dirty tree to lay out again. The subscription's first report is
   * the baseline instead.
   */
  const slideSync = () => {
    // The column is cached by chat-dom.js: asking the document for it on every
    // frame of a stream forced a style pass over the whole page.
    const column = conversationColumn()
    if (column === slideColumn) return
    if (stopSlideSize !== null) stopSlideSize()
    stopSlideSize = null
    stopSlide()
    slideColumn = column
    slideArmed = false
    slideHeight = 0
    slideScrollTop = null
    slideReaderRevision = 0
    seenAtTail = false
    // A new column is a new conversation: the pace the old one streamed at is no
    // reading of how fast this one's pieces arrive.
    grewAt = 0
    grewEvery = 0
    if (column === null) return
    stopSlideSize = observeSize(column, onSlideResize, { afterHost: true })
  }

  /** Keep the door's hold mark on the column while a door rolls. */
  const holdCheck = () => {
    if (foldBusy() && !readerAway()) {
      slideSync()
      if (slideColumn !== null) markHold(slideColumn)
      return
    }
    releaseHold()
  }

  /** The size reading's own block size. */
  const blockSize = (entry) => {
    const size = entry.borderBoxSize
    return size !== undefined && size.length > 0 ? size[0].blockSize : entry.contentRect.height
  }

  /**
   * Put this frame's growth back under a reader who holds the conversation.
   *
   * The host's own follow pins the end on every growth while its mark stands,
   * and a finger pressed on the screen sends no scroll of its own: nothing puts
   * the host into its sampling window, so nothing stands its pin down, and the
   * position the reader held moves one growth per burst. The slide is refused
   * while he holds, so this is the one writer left for it. A position away from
   * the end is the reader's own and stays where he put it.
   */
  const holdGrowth = (column, previousScrollTop, readerMoved) => {
    const scroller = column.closest(CONVERSATION_SCROLL_SELECTOR)
    if (scroller === null || column.closest(FOLLOWING_TAIL_SELECTOR) === null) return
    if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 0.5) return
    if (foldBusy()) return
    // New travel since the previous growth belongs to the reader and is kept.
    // Otherwise restore the position the previous growth actually ended at: an
    // older absolute record could belong to another layout epoch.
    const position = readerMoved ? readerScrollPosition(scroller) : previousScrollTop
    if (position === null) return
    writeScroll(scroller, position, 'reader')
  }

  /**
   * The column's own box is what grows while text streams, and a resize is the
   * moment the host has just pinned the end: read the growth this frame brought
   * and slide it, or give it back to a reader holding it.
   */
  const onSlideResize = (entries) => {
    const column = slideColumn
    let grew = 0
    for (const entry of entries) {
      if (column === null || entry.target !== column) continue
      const box = blockSize(entry)
      // The subscription's first report for a column is its height as mounted:
      // the baseline a later growth is measured against, never a growth itself.
      if (!slideArmed) {
        slideArmed = true
        slideHeight = box
        const scroller = column.closest(CONVERSATION_SCROLL_SELECTOR)
        slideScrollTop = scroller === null ? 0 : scroller.scrollTop
        slideReaderRevision = scroller === null ? 0 : readerScrollRevision(scroller)
        continue
      }
      const delta = box - slideHeight
      slideHeight = box
      // A structural shrink moves the host's pin by the height that left. An
      // offset from growth before it would add a second, downward move.
      if (delta < 0) stopSlide()
      // Any growth is slid, a burst included: startSlide's clamp bounds what a
      // glide carries, and a column the host replaced is no longer the one
      // watched here (slideSync re-subscribes when it changes).
      if (delta > 0) {
        grew = delta
        // A faster arrival bounds this slide at once; smoothing a shorter gap
        // would carry the old pause into the new stream and let offsets build up.
        // Slower arrivals still ease toward their own pace.
        const now = performance.now()
        if (grewAt > 0) {
          const gap = now - grewAt
          grewEvery = grewEvery === 0 ? gap : Math.min(gap, grewEvery * 0.6 + gap * 0.4)
        }
        grewAt = now
      }
    }
    const scroller = column === null ? null : column.closest(CONVERSATION_SCROLL_SELECTOR)
    noteTailIfNear(scroller)
    const scrollTop = scroller === null ? null : scroller.scrollTop
    const previousScrollTop = slideScrollTop
    const revision = scroller === null ? 0 : readerScrollRevision(scroller)
    const readerMoved = revision !== slideReaderRevision
    // Sibling rows can change the pin by less or more than the column grew.
    // Compensate the host's actual position write, not only the column's delta.
    const moved = slideScrollTop === null || scrollTop === null ? 0 : scrollTop - slideScrollTop
    slideScrollTop = scrollTop
    slideReaderRevision = revision
    holdCheck()
    if (column === null || grew === 0) return
    if (readerAway()) {
      holdGrowth(column, previousScrollTop, readerMoved)
      if (scroller !== null) {
        slideScrollTop = scroller.scrollTop
        slideReaderRevision = readerScrollRevision(scroller)
      }
      return
    }
    if (!slideWanted(column)) return
    if (moved < 0) stopSlide()
    if (moved > 0) startSlide(column, scroller, moved)
  }

  /**
   * Hand this round's follow back. Three gates have to open: the position, the
   * reader's intent and a fold glide in flight.
   */
  const ensure = (attempt) => {
    if (stopped || readerAway()) return
    const scroller = conversationScroller()
    if (scroller === null) return
    noteTailIfNear(scroller)
    // A conversation opened onto a saved historical position has never followed the tail.
    if (!seenAtTail) return
    // More than a screen off the end is the reader reading higher up, not a
    // follow that fell one step behind.
    if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > scroller.clientHeight) return
    // A fold glide is moving the height, and the position is its business until it lands.
    if (foldBusy()) {
      const tries = typeof attempt === 'number' ? attempt : 0
      if (tries >= FOLLOW_FOLD_WAIT_ATTEMPTS) return
      if (foldWaitTimer !== null) window.clearTimeout(foldWaitTimer)
      foldWaitTimer = window.setTimeout(() => {
        foldWaitTimer = null
        ensure(tries + 1)
      }, FOLLOW_FOLD_WAIT_MS)
      return
    }
    const now = performance.now()
    if (now - lastEnsureAt < FOLLOW_MIN_INTERVAL_MS) return
    lastEnsureAt = now
    // A hand-back in flight outlives the frame it began in, so it is told the
    // feature is gone rather than only that the reader is still up there.
    handBackFollow({ stillWanted: () => !stopped && !readerAway() })
  }

  /** A batch of mutations is settled: decide whether to act. */
  const settle = () => {
    const structure = structureSeen
    const guarded = guardSeen
    structureSeen = false
    guardSeen = false
    // The guard side needs the extra "work in progress" test: the attribute
    // going away can also be a session switch or history being restored.
    if (!structure && !(guarded && running())) return
    ensure(0)
  }

  const queue = () => {
    if (scanQueued || stopped) return
    scanQueued = true
    // The hand-back reads the position and writes it in one go, in the scroll
    // phase, while the frame's reads have left the layout settled.
    cancelScan = requestFrame({
      read() {
        if (!tailReadWanted) return
        tailReadWanted = false
        noteTailIfNear(conversationScroller())
      },
      scroll() {
        cancelScan = null
        scanQueued = false
        settle()
      },
    })
  }

  /** Whether a newly added node holds a flow block or a tool call row. */
  const marksStructure = (node) => {
    if (!(node instanceof Element)) return false
    return node.matches(FOLLOW_STRUCTURE_SELECTOR) || node.querySelector(FOLLOW_STRUCTURE_SELECTOR) !== null
  }

  const onRecords = (records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        // The reader took the conversation over: a slide still carrying an
        // offset would leave what he scrolls to off its place.
        if (record.attributeName === READER_HOLD_ATTR) {
          if (record.target instanceof Element && record.target.hasAttribute(READER_HOLD_ATTR)) stopSlide()
          continue
        }
        // The follow went from present to absent: the host just turned it off.
        if (record.attributeName === FOLLOWING_TAIL_ATTRIBUTE) {
          if (record.target instanceof Element && !record.target.hasAttribute(FOLLOWING_TAIL_ATTRIBUTE)) {
            guardSeen = true
            // Whether this was a follow that fell behind or a reader who is
            // reading higher up is decided by the position, and this is the one
            // moment it has to be read: the mark itself is gone, so the numeric
            // reading is the only answer left.
            if (!seenAtTail) tailReadWanted = true
          }
          continue
        }
        // A thinking row leaving "running": the boundary of that piece of work.
        if (record.oldValue === RUNNING_STATE
          && record.target instanceof Element
          && record.target.matches(THINK_ROW_SELECTOR)
          && record.target.getAttribute(ROW_PHASE_ATTRIBUTE) !== RUNNING_STATE) {
          lastActivityAt = performance.now()
          structureSeen = true
          // The row may shrink in this same batch. End its growth offset before
          // that structural change paints; the resize subscription is the backup.
          stopSlide()
        }
        continue
      }
      for (const node of record.addedNodes) {
        if (!marksStructure(node)) continue
        lastActivityAt = performance.now()
        structureSeen = true
      }
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue
        if (node.matches(CHAT_RUNNING_SELECTOR) || node.querySelector(CHAT_RUNNING_SELECTOR) !== null) {
          // The live row leaving is the stream's structural boundary. Its last
          // growth offset ends in this mutation batch, ahead of the next paint.
          stopSlide()
          break
        }
      }
    }
    const before = slideColumn
    if (records.some((record) => record.type !== 'attributes')) {
      slideSync()
      holdCheck()
      // Read the tail at most once per frame, only for a different column or
      // content arriving in this transcript. Mutations elsewhere never force
      // layout in a conversation restored at its saved reading position.
      const scroller = conversationScroller()
      if (!seenAtTail && scroller !== null && (before !== slideColumn || records.some(
        (record) => record.type !== 'attributes' && scroller.contains(record.target),
      ))) tailReadWanted = true
    }
    if (structureSeen || guardSeen || tailReadWanted) queue()
  }

  const stopMutations = subscribeMutations(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributeFilter: [ROW_PHASE_ATTRIBUTE, FOLLOWING_TAIL_ATTRIBUTE, READER_HOLD_ATTR],
    attributeOldValue: true,
  }, onRecords)

  return () => {
    // First: a queued pass or a waiting retry would otherwise hand the position
    // back after the feature is off, pressing the host's own back-to-end button.
    stopped = true
    if (cancelScan !== null) cancelScan()
    cancelScan = null
    scanQueued = false
    if (foldWaitTimer !== null) window.clearTimeout(foldWaitTimer)
    foldWaitTimer = null
    stopMutations()
    if (stopSlideSize !== null) stopSlideSize()
    stopSlideSize = null
    stopSlide()
    releaseHold()
    runningRows.release()
    thinkRows.release()
    runningMarks.release()
    slideColumn = null
    leaveOwner()
  }
}

/**
 * Install the guard, the process catch-up and the button's placement. This
 * teardown hands the chat area back whole.
 *
 * @param options.foldBusy - whether a fold glide is animating a height right now.
 * @param options.submissionHeld - whether the reader's own message is still taking its place.
 * @param options.motionReduced - whether the page must hold its animations still.
 */
export function installFollow(options) {
  const stopGuard = createFollowGuard(options)
  const stopProcess = createProcessFollow()
  const cards = observeMatches(COMPOSER_CARD_SELECTOR)
  let marked = null
  let stopped = false

  /**
   * Read now, write on the next frame. Each call keeps its own reading: two
   * passes can queue into the same frame — a composer resize and the mutation
   * that mounts the button often do — and a reading held in one shared slot is
   * taken by whichever write runs first, leaving the second to read `null` and
   * take the mark back off.
   */
  const place = () => {
    if (stopped) return
    const placement = readTailPlacement(cards.all())
    requestFrame({
      write() {
        if (stopped) return
        marked = writeTailPlacement(marked, placement)
      },
    })
  }

  window.addEventListener('resize', place)
  const scroller = conversationScroller()
  const stopScrollerSize = scroller === null ? null : observeSize(scroller, place)
  const stopCardSize = observeSize(cards.all(), place)
  // The button appears only when the host's follow is off, and that is a
  // mutation: place it on the batch that mounts it.
  const stopWatch = subscribeMutations(document.body, { childList: true, subtree: true }, () => {
    if (stopped) return
    if (findFollowTailButton() === null) {
      if (marked !== null) {
        marked.removeAttribute(TAIL_ATTR)
        marked = null
      }
      return
    }
    place()
  })
  place()

  return () => {
    stopped = true
    stopWatch()
    if (stopScrollerSize !== null) stopScrollerSize()
    stopCardSize()
    if (marked !== null) marked.removeAttribute(TAIL_ATTR)
    marked = null
    cards.release()
    stopGuard()
    stopProcess()
  }
}
