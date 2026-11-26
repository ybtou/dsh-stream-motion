/**
 * What both halves of this package agree on: the name every mark and every
 * console line carries, and the two body gates the stylesheets hang off.
 *
 * The reveal's gate is separate from the follow's because the reveal can be
 * unavailable while the follow works: a browser without the Custom Highlight API
 * gets the smooth scroll and no fade, and its step rules are never mounted, so
 * nothing in the page refers to a highlight that will never be drawn.
 */

/** The bundle's own name: the tag on its stylesheets, and the prefix on everything it writes. */
export const PACKAGE_NAME = 'dsh-stream-motion'

/** On `<body>` while the follow half runs. */
export const FOLLOW_ATTR = 'data-dsh-stream-motion'

/** On `<body>` while the reveal half runs; the step rules hang off it. */
export const REVEAL_ATTR = 'data-dsh-stream-motion-reveal'

/** The one stylesheet the package mounts, holding both halves' rules. */
export const STYLE_ID = 'dsh-stream-motion-style'
