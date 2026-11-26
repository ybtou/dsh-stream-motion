/** Host-owned marks the follow reads. Nothing here is written by this package. */
export const STREAMING_SELECTOR = '[data-streaming]'
export const SHIMMER_SELECTOR = '[data-shimmer]'
export const CHAT_FLOW_SELECTOR = '[data-chat-flow]'
export const CHAT_RUNNING_SELECTOR = '[data-chat-running]'
export const THINK_ROW_SELECTOR = '[data-variant="think"]'
export const CONVERSATION_SCROLL_SELECTOR = '[data-conversation-scroll]'
export const COMPOSER_CARD_SELECTOR = '[data-composer-card]'
export const PROCESS_BODY_SELECTOR = '[data-step-process-body]'
export const PROCESS_CONTENT_SELECTOR = '[data-step-process-content]'
export const PROCESS_EXPANDED_MODE_ATTRIBUTE = 'data-group-expanded-mode'
export const DISCLOSURE_HEADER_SELECTOR = '[data-disclosure-header]'
export const DISCLOSURE_ROW_SELECTOR = '[data-disclosure-row]'
export const EXPANDED_ATTRIBUTE = 'data-expanded'
export const FOLLOWING_TAIL_SELECTOR = '[data-chat-following-tail]'
export const ROW_PHASE_ATTRIBUTE = 'data-state'
export const RUNNING_STATE = 'running'
export const FLOW_KIND_ATTRIBUTE = 'data-chat-flow-kind'
export const SUBMISSION_ECHO_SELECTOR = '[data-submission-echo]'
export const USER_ROW_KIND = 'user'
export const PHASE_ATTRIBUTE = 'data-phase'
export const CONVERSATION_SESSION_ATTRIBUTE = 'data-conversation-session'
export const CONVERSATION_SESSION_SELECTOR = `[${PHASE_ATTRIBUTE}="active"] [${CONVERSATION_SESSION_ATTRIBUTE}]`
export const SIDEBAR_SLOT_SELECTOR = '[data-slot="sidebar"]'
export const COMPOSER_SELECTOR = '[data-composer-seat]'

/** How close to the tail a container has to come for a hold on it to end. */
export const FOLLOW_THRESHOLD_PX = 25
/** How close to a process body's own end the reader has to come for his hold on it to end. */
export const PROCESS_RELEASE_THRESHOLD_PX = 4
/** Gap past which the process catch-up replaces the host's own slow smooth scroll. */
export const CATCH_UP_GAP_PX = 40

/** The marks this package writes. */
export const FOLLOW_ATTR = 'data-dsh-stream-motion'
export const FOLLOW_HOLD_ATTR = 'data-dsh-stream-motion-hold'
export const READER_HOLD_ATTR = 'data-dsh-stream-motion-reader-hold'
export const TAIL_ATTR = 'data-dsh-stream-motion-tail'
export const STYLE_ID = 'dsh-stream-motion-style'

/** The longest stretch a glide carries, in pixels: a farther destination is first closed to it. */
export const SCROLL_EASE_LEAD_PX = 1200
/** The stream slide's own length; the pace pieces arrive at can shorten it, never lengthen it. */
export const SLIDE_MS = 240
/** A burst sets its own time off the distance: sqrt(px) × this, inside the band. */
export const SLIDE_BURST_MS_PER_ROOT_PX = 12
export const SLIDE_BURST_MAX_MS = 620
/** The curve the stream's slide travels on, and the one `slideCarried` evaluates. */
export const GLIDE_EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)'

/** A door's own length: how long a tool or thinking row takes to roll shut or open. */
export const FOLD_ROLL_MS = 220
/** The share of a roll spent on the part of the box that is on screen. */
export const FOLD_VISIBLE_SHARE = 0.9
/** How long an opening press waits for the host to insert the body it opens. */
export const FOLD_INTENT_TTL_MS = 500
/** A menu or dialog: its opening must not move the chat flow. */
export const FOLD_POPUP_SELECTOR = '[aria-haspopup]'
/** How many frames to wait for the host's collapse before dropping the pinned height. */
export const FOLD_SHUT_CONFIRM_FRAMES = 3
/** The margin past a roll in which the position still belongs to the animation. */
export const FOLD_BUSY_GRACE_MS = 50

/** How long the stream slide stands down after a submission arrives. */
export const SUBMISSION_HOLD_MS = 1200
/** How many times a hand-back looks again, and the gap between two looks. */
export const FOLLOW_LOOK_ROUNDS = 5
export const FOLLOW_LOOK_INTERVAL_MS = 100
/**
 * The looks a press on the host's button spends: the position is travelled to
 * the end first, so the rounds cover the travel and the settlement after it.
 */
export const TAIL_PRESS_LOOK_ROUNDS = 30

/**
 * The curve a press travels on: slow off the mark, fastest in the middle, slow
 * into the target. Its control points are the ones Material's standard curve
 * uses — a shallow start and a long settle — which is what reads as a push-off
 * followed by a landing rather than a lurch followed by a stop.
 */
export const TAIL_PRESS_CURVE = 'cubic-bezier(0.4, 0, 0.2, 1)'
/** How long the press takes at the shortest and longest travel, in milliseconds. */
export const TAIL_PRESS_MIN_MS = 220
export const TAIL_PRESS_MAX_MS = 700
/**
 * The duration's shape against the distance: `sqrt(px) * this`. A square root
 * rather than a proportion, because the reader's sense of speed is not linear in
 * distance — doubling the trip should not double the wait. At 12 ms per root
 * pixel a 1600 px travel takes 480 ms and a 400 px one takes 240 ms.
 */
export const TAIL_PRESS_MS_PER_ROOT_PX = 12

/**
 * The host's back-to-end button stands outside the composer's top-right corner.
 * These are the two numbers its stylesheet reads, written per pass from what the
 * read phase measured: the composer's own edges move as a draft wraps and as the
 * sidebars take width.
 */
export const FOLLOW_TAIL_AIR_PX = 12
export const TAIL_RIGHT_VAR = '--dsh-stream-motion-tail-right'
export const TAIL_BOTTOM_VAR = '--dsh-stream-motion-tail-bottom'

/** The spring: critically damped, so a target that grows mid-flight is only a wider gap. */
export const EASE_OMEGA = 28
export const EASE_MAX_SPEED_PX_S = 2400
export const EASE_MAX_ACCEL_PX_S2 = 24000
export const EASE_DONE_PX = 0.5
export const EASE_REST_PX_S = 10
export const EASE_STEP_S = 0.001
export const EASE_MOVED_PX = 1.5
export const EASE_MAX_FRAME_MS = 64
export const EASE_NOMINAL_FRAME_MS = 16.7

/** The keys that scroll the viewport; the same set the host reads. */
export const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])
/** The reader's intent events. */
export const INTENT_TYPES = ['wheel', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'pointerdown', 'keydown', 'beforematch']
export const MOVING_INTENT_TYPES = new Set(['wheel', 'touchstart', 'pointerdown', 'keydown'])
/** Scroll keys that move away from the conversation's tail; Shift+Space joins them. */
export const UPWARD_SCROLL_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])
/** The two ends of a touch drag. */
export const TOUCH_END_TYPES = new Set(['touchend', 'touchcancel'])
