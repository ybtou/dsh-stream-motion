/**
 * The step rules, written at runtime from params.js.
 *
 * `::highlight()` accepts no `opacity` — its property set is small and does not
 * include it — so the fade rides on the colour's own alpha: one rule per step,
 * each mixing the element's published colour with `transparent`.
 *
 * The subject is the element the reveal paints text in, never "anything under
 * the streaming block": a descendant-combinator subject re-matches every
 * element below it on each batch, which measures as the whole page's style
 * recalc while a stream runs. The mark narrows the subject to what is actually
 * painted.
 */

import {
  CHAT_REVEAL_ALPHA_CURVE,
  CHAT_REVEAL_ATTR,
  CHAT_REVEAL_COLOR_VAR,
  CHAT_REVEAL_HIGHLIGHT_PREFIX,
  CHAT_REVEAL_MIN_OPACITY,
  CHAT_REVEAL_RUN_ATTR,
  CHAT_REVEAL_STEPS,
  STREAMING_SELECTOR,
} from './params.js'

/**
 * The rules for the current constants.
 * @returns CSS text; safe to mount at any time, and only ever read through the body gate.
 */
export function stepRules() {
  // Two subjects, both a single compound on the marked element: text can hang
  // directly off the streaming container (a one-line reasoning summary) as well
  // as off an element below it (a markdown body), and a descendant combinator
  // alone would leave the first case painted but never faded.
  const mark = `[${CHAT_REVEAL_RUN_ATTR}]`
  const subjects = [
    `body[${CHAT_REVEAL_ATTR}] ${STREAMING_SELECTOR} ${mark}`,
    `body[${CHAT_REVEAL_ATTR}] ${STREAMING_SELECTOR}${mark}`,
  ]
  const floor = CHAT_REVEAL_MIN_OPACITY
  const curve = CHAT_REVEAL_ALPHA_CURVE
  const rules = []
  for (let step = 0; step < CHAT_REVEAL_STEPS; step += 1) {
    const name = `${CHAT_REVEAL_HIGHLIGHT_PREFIX}${step}`
    const reached = step / (CHAT_REVEAL_STEPS - 1)
    const alpha = ((floor + (1 - floor) * (1 - (1 - reached) ** curve)) * 100).toFixed(2)
    // The pseudo-class goes on each subject: a selector list shares one, so
    // `a, b::highlight(n)` would only ever paint the second.
    const selector = subjects.map(subject => `${subject}::highlight(${name})`).join(',\n')
    rules.push(
      `${selector} {\n`
      + `  color: color-mix(in srgb, var(${CHAT_REVEAL_COLOR_VAR}, currentColor) ${alpha}%, transparent);\n`
      + '}\n',
    )
  }
  return rules.join('\n')
}
