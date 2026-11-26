/**
 * The reveal's numbers, ported from dsh-claude-style's chat-reveal.
 *
 * The fade's duration is the one value a page may override: every other number
 * is a bound on work, not a taste, and moving one without re-reading its note
 * changes what the engine survives rather than how it looks.
 */

/** How long one character takes to reach its own colour. The engine may replace this before it starts. */
export let CHAT_REVEAL_MS = 240

/** How many alpha steps a character walks through; each step is one `::highlight()` rule. */
export const CHAT_REVEAL_STEPS = 8

/** The faintest step: a character arrives unseen, so the fade is the arrival rather than a dim start to read through. */
export const CHAT_REVEAL_MIN_OPACITY = 0

/** How the step table spends its alphas: a step that has reached `t` of the fade holds `1 - (1 - t) ** curve` of the colour. */
export const CHAT_REVEAL_ALPHA_CURVE = 2

/** The prefix of each step's highlight name, and the property an element publishes its own colour to. */
export const CHAT_REVEAL_HIGHLIGHT_PREFIX = 'dsh-stream-motion-tok-'
export const CHAT_REVEAL_COLOR_VAR = '--dsh-stream-motion-run-color'

/** On an element the reveal draws text in: the subject of every step rule. */
export const CHAT_REVEAL_RUN_ATTR = 'data-dsh-stream-motion-run'

/** On `<body>` while the engine runs: the gate every step rule hangs off. */
export const CHAT_REVEAL_ATTR = 'data-dsh-stream-motion-reveal'

/** Stagger scales with the fade duration; the bounds keep the sweep visible without delaying trailing characters. */
export const CHAT_REVEAL_STAGGER_DIVISOR = 50
export const CHAT_REVEAL_MIN_STAGGER_MS = 1
export const CHAT_REVEAL_MAX_STAGGER_MS = 8

/** Folding rewrites a still-streaming container; skip it until the host's mutations settle. */
export const CHAT_REVEAL_FOLD_QUIET_MS = 400

/** Oversized batches are shown without reveal. */
export const CHAT_REVEAL_BURST_LIMIT = 10000

/** Bound all overlapping batches together, before allocating character segments. */
export const CHAT_REVEAL_ACTIVE_LIMIT = 2048

/** How many characters a container that just appeared may hold and still count as "the start of an answer". */
export const CHAT_REVEAL_FIRST_SIGHT_LIMIT = 200

/** A gap between frames longer than this means no frame was drawn in between. */
export const CHAT_REVEAL_FRAME_GAP_MS = 40

/** A normal frame at 60 Hz; the compensation subtracts it from the blank. */
export const CHAT_REVEAL_NOMINAL_FRAME_MS = 16.7

/** A frame gap longer than this counts as slow: under 20 fps the fade's steps sit for tens of milliseconds each. */
export const CHAT_REVEAL_SLOW_FRAME_MS = 50

/** This many slow frames in a row before the engine gives way; one long task must not switch the fade off. */
export const CHAT_REVEAL_SLOW_FRAME_RUN = 4

/** A gap this long is a hidden page (rAF stopped), not a busy main thread. */
export const CHAT_REVEAL_HIDDEN_GAP_MS = 1000

/** How long after giving way new characters are let through at full strength. */
export const CHAT_REVEAL_YIELD_MS = 3000

/** The most characters the rewritten middle may hold and still be diffed; beyond it the whole block was rewritten. */
export const CHAT_REVEAL_REWRITE_DIFF_BUDGET = 4096

/** The most characters a diffed rewrite may add and still animate. */
export const CHAT_REVEAL_LOCAL_REWRITE_LIMIT = 64

/** The host's mark on a container whose answer is still arriving. */
export const STREAMING_SELECTOR = '[data-streaming]'
export const STREAMING_ATTRIBUTE = 'data-streaming'

/** Replace the fade duration; a value that is not a positive finite number is ignored. */
export function configureFade(ms) {
  if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) CHAT_REVEAL_MS = ms
}

/** Per-session state: the engine replaces it on the session broadcast and on teardown. */
export function createRevealState() {
  return {
    liveRuns: [],
    historyContainers: new WeakSet(),
    textSnapshots: new WeakMap(),
    foldQuietUntil: new WeakMap(),
    liveContainers: [],
    cursor: 0,
    lastFrameAt: 0,
    slowFrames: 0,
    yieldUntil: 0,
    cancelPaintFrame: null,
    baselinePending: false,
  }
}
