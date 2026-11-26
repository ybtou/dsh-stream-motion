/**
 * Host half: a row with no service, no tools and no slots.
 *
 * The bundle exists to load the client module into the web app, so this file
 * only holds the row open.
 */

export function apply(ctx) {
  return ctx.effect(() => () => {}, 'dsh-stream-motion: host row')
}
