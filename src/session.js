/**
 * The session marks both halves read, and nothing else.
 *
 * The host puts `data-conversation-session` on the conversation body and
 * `data-phase` on the conversation root. Reading them lets each half keep its
 * scope to the session on screen: a container belonging to another session — a
 * background one still mounted, a page of history being laid out — is neither
 * faded nor followed, and a switch ends every snapshot, range, hold and pending
 * frame.
 */

import { subscribeMutations } from './bus.js'

const SESSION_SELECTOR = '[data-phase="active"] [data-conversation-session]'
const SESSION_ATTRIBUTE = 'data-conversation-session'
const PHASE_ATTRIBUTE = 'data-phase'

/** The id of the session the page shows, or null while none is chosen. */
export function conversationSession() {
  const element = document.querySelector(SESSION_SELECTOR)
  if (element === null) return null
  const id = element.getAttribute(SESSION_ATTRIBUTE)
  return id === null || id === '' ? null : id
}

/**
 * Whether this node belongs to the session on screen. A node outside any
 * session mark counts as belonging: the reveal must not stop working where the
 * host renders without one.
 */
export function inCurrentConversation(node) {
  const owner = node.closest(`[${SESSION_ATTRIBUTE}]`)
  if (owner === null) return true
  return owner.getAttribute(SESSION_ATTRIBUTE) === conversationSession()
}

/**
 * Hear each session the page switches to, once per change. The host names the
 * shown session on the conversation column; that id changing is the one signal
 * every per-session state can be released by.
 *
 * @param onChange - called with the new id whenever the shown session changes.
 * @returns the stop.
 */
export function observeSession(onChange) {
  let last = conversationSession()
  return subscribeMutations(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [PHASE_ATTRIBUTE, SESSION_ATTRIBUTE],
  }, () => {
    const next = conversationSession()
    if (next === last) return
    last = next
    onChange(next)
  })
}
