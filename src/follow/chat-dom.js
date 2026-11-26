import {
  CHAT_FLOW_SELECTOR,
  CONVERSATION_SCROLL_SELECTOR,
  FLOW_KIND_ATTRIBUTE,
  SUBMISSION_ECHO_SELECTOR,
  USER_ROW_KIND,
} from './params.js'

/**
 * Chat DOM helpers over host-owned literals. Every selector here is one the
 * host writes; this package marks nothing of its own in the chat tree.
 */

/** Cache the host scroller: a per-frame query forces a style pass over the whole page. */
let scroller = null

export function conversationScroller() {
  if (scroller === null || !scroller.isConnected) {
    scroller = document.querySelector(CONVERSATION_SCROLL_SELECTOR)
  }
  return scroller
}

/** Cache the flow column for stream frames; session replacement invalidates it through `isConnected`. */
let column = null

export function conversationColumn() {
  if (column === null || !column.isConnected) {
    column = document.querySelector(CHAT_FLOW_SELECTOR)
  }
  return column
}

/**
 * Detect the classic scrollbar by event target and `clientWidth` geometry.
 * Overlay scrollbars occupy no strip and therefore return false.
 */
export function isScrollbarStrip(container, event, target) {
  if (target !== container) return false
  const box = container.getBoundingClientRect()
  return event.clientX >= box.left + container.clientWidth
}

/**
 * The host's own back-to-end button. It renders only while the host's follow is
 * off, so finding one is how this package reads "the follow is off". The shape
 * is the column's grandparent frame followed by the slot the button stands in;
 * a page whose shape differs answers null, and every caller treats that as "no
 * button" rather than guessing.
 */
export function findFollowTailButton() {
  const flow = conversationColumn()
  if (flow === null || flow.parentElement === null) return null
  const root = flow.parentElement.parentElement
  if (root === null || root.nextElementSibling === null) return null
  return root.nextElementSibling.querySelector('button')
}

/** Settled and optimistic echo rows carry marks at different depths and need separate selectors. */
export const SUBMISSION_ROW_SELECTOR = `[${FLOW_KIND_ATTRIBUTE}="${USER_ROW_KIND}"], ${SUBMISSION_ECHO_SELECTOR}`
