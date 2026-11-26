<div align="center">

# dsh-stream-motion

**Two things the chat does while an answer arrives: new characters fade in, and the text the host's pin pushes up is slid back into place instead of jumping.**

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.en.md)
[![简体中文](https://img.shields.io/badge/lang-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red.svg)](README.md)

</div>

A DeepSeek Harness plugin. The fade and the slide were taken from
[dsh-claude-style](https://github.com/nwflower/dsh-claude-style), where they are
two features of a theme; here they are one plugin that needs no theme. See
[Reference project](#reference-project) for exactly what was derived and what is
new.

## Supported DSH version

**Only DSH `0.2.3-alpha.2`.** The manifest pins it exactly —
`"engines": { "dsh": "0.2.3-alpha.2" }` — so installation on any other version is
refused with `incompatible-version` rather than attempted.

The pin is exact on purpose. This package holds the chat frame's DOM shape: it
finds the back-to-end button by walking the column's grandparent to the next
sibling slot, reads `data-chat-following-tail` / `data-chat-flow` /
`data-chat-running` / `data-step-process-body` off the host's own nodes, and
writes into the scroll container the host owns. Every one of those is host
internals, not a published contract. A caret range would have accepted
`0.2.3-alpha.3`, `0.2.3-beta.1`, `0.2.3` and `0.2.4` — all of them plausible
prerelease or patch steps, none of them verified here. On a version this package
was never run against, the failure modes are silent and worse than a refusal:
a moved frame answers "no button" and the hand-back quietly stops, a renamed mark
makes a guard read `false` forever, and a scroll container that changed owner
turns the position arbitration into a second writer fighting the host.

Raising the pin is a testing act, not a version edit. Run
`node test/reveal-probe.mjs`, `node test/follow-probe.mjs`,
`node test/tail-press.mjs` and `node test/live.mjs` against the new runtime, and
re-check the DOM marks in the table under "How it works" against the host's
`dsh-client-ui-chat` build, before widening the range.

To install anyway on an unverified version, DSH takes an explicit exact-version
exemption for `dsh-stream-motion@0.1.0` on that runtime — through the plugin
manager, or `dsh plugin allow-version`. Treat what happens next as untested.

## Install

```bash
npm install          # esbuild, the only dev dependency
npm run build        # src/ -> lib/client.js + lib/host.js
```

Then point DSH's plugin manager at this folder (`install_bundle`), or install the
built directory as a local bundle. `lib/` is committed, so a clone can be
installed without building; build again after touching `src/`.

## What it does

**The fade.** Characters arrive faint and come to rest, one alpha step per
frame, so a long reply reads as writing rather than as blocks appearing. The
order the characters arrive in is kept: a batch that lands after another never
overtakes it, and the fade is timed to the pace the pieces arrive at.

**The slide.** While an answer streams the host keeps the conversation pinned to
its end: every piece that arrives writes the end outright, which pushes the text
above the last line up by the growth in a single frame. This plugin puts the
column back down by that growth and glides it to rest on the compositor, so the
reader's eye stays on the same line instead of being kicked up on every burst.
The live turn's row is pinned to the scroller's bottom and would ride that
offset, so it gets the same slide reversed in the same frame and stands still.

**The hand-back.** The chat area's follow is lost at a few moments — a tool row
mounting, a thinking row leaving `running`, a fold glide landing, a session
switch, history being restored. The host turns its own follow off on any write
inside its 500 ms sampling window and leaves one way back: the back-to-end button
it renders only while off. The guard presses that button for you.

The host puts that button in the column's right gutter, centred over the
conversation. This package moves it outside the composer's top-right corner —
where the reader is actually looking, since the end of the text sits right above
the box they are typing in — anchored on the right edge so the button's own width
never has to be known. Both numbers are measured per pass, because both edges
move: the composer grows as a draft wraps, and the sidebars take width from the
column.

**The smoothed press.** Pressing that button is itself smoothed. The host's
handler writes the end in a single frame, which teleports the reader; the press
is taken before the host's handler runs and the position is travelled to the end
on a timed ease — slow off the mark, fastest in the middle, settling flush on the
target — then the button is pressed for real to turn the host's follow back on.
A timed ease rather than the spring, because this travel has a shape the reader
is meant to see; a spring approaches its target asymptotically, so the last
pixels crawl, and its lead would move the reader a screenful in the first frame.
The duration is read off the distance (`sqrt(px) * 12`, clamped to 220–700 ms), so
a short trip is quick and a long one is not a wait.

**The catch-up.** A capped process body (the collapsible tool output) is walked
to its own end on a critically damped spring once it falls more than 40 px
behind, which reads as a catch-up rather than the host's slow smooth scroll.

## How it works

Nothing here parses a network stream. Every input is a mark the host already
writes, and this package marks nothing inside the chat tree:

| Mark | Written by the host on | Read here as |
| --- | --- | --- |
| `data-streaming`, `data-shimmer` | the answer container / the thinking summary | content is arriving |
| `data-chat-following-tail` | the chat root | the host's own follow is on |
| `data-chat-flow` | the flow column | the box whose growth is slid |
| `data-conversation-scroll` | the conversation scroller | the position's owner |
| `data-chat-running` | the live turn's row | pinned to the scroller's bottom, so it needs a counter-slide |
| `data-step-process-body` | a capped tool group's body | the box to catch up |
| `data-conversation-session`, `data-phase` | the conversation body and root | which session is on screen |

The fade rides on `::highlight()`: the pseudo-element's property set has no
`opacity`, so alpha is spent on the colour instead, one rule per step, each
mixing the element's own published colour with `transparent`. The rule's subject
is the element the text hangs off — never "anything under the streaming block",
because a descendant-combinator subject re-matches every element below it on
each batch, which measures as the whole page's style recalc while a stream runs.

The slide is one `Animation` on the flow column: `translateY(growth)` to
`translateY(0)` on `cubic-bezier(0.22, 0.61, 0.36, 1)`, capped at 240 ms and
timed to the gap the last two pieces kept — a slide still moving when the next
piece lands would start its restart from a distance it had not paid back yet, so
the offset would grow with every burst. An additive animation stays off the
compositor, which is why the distance carried is read off the animation's own
clock and curve and restarted rather than added to.

The scroll position has one writer. Six sources rank
`jump > fold > reader > composer > follow > process`; a request below the ease
running is refused, and the following sources are refused while the reader holds
the container. A reader who scrolls takes the hold until they come back to the
end.

## Tests

```bash
npm test                            # the three browser harnesses
node test/live.mjs                  # against a running DSH web app
```

The three harnesses drive a headless Chromium over CDP against a fake host page,
so they need no DSH install. `test/live.mjs` reads the `?token=` URL out of the
running app's log, drives the real chat frame, and is the one that catches a
host that moved.

## Limitations

- Tested only against DSH `0.2.3-alpha.2`, and the manifest pins exactly that
  version. See "Supported DSH version" above.
- The fade needs the Custom Highlight API (Chromium 105+, Safari 17.2+). Without
  it the fade stands down and the slide still works.
- The slide needs `Element.prototype.animate`. Without it the slide stands down
  and the fade still works. Only a browser missing both gets nothing, and then
  the page is left unmarked.
- The host's back-to-end button is found by the shape of the chat frame: the
  column's grandparent frame followed by the slot the button stands in. A host
  that restructures that frame answers "no button", and both the hand-back and
  the smoothed press are skipped rather than guessed at.
- A conversation opened onto a saved reading position never counts as following
  the tail, so the hand-back leaves it alone: the reader's own place is not
  walked to the end.
- Under reduced motion the fade and the slide stand down, and the press is left
  to the host's own jump. Reduced motion is read from the page:
  `data-dsh-stream-motion-motion="reduced"` or `"full"` wins, and with neither
  the system preference answers.
- The fade duration, the slide token and the catch-up threshold are constants
  here, not settings.

## Reference project

The fade and the slide are ports, not inventions. Both come from
**[dsh-claude-style](https://github.com/nwflower/dsh-claude-style)** by
[Nwflower](https://github.com/nwflower) — MIT licensed, Copyright (c) 2026
Nwflower — where they live as the `chat-reveal` and `chat-follow` features of a
Claude-Code-style theme, on top of a shared engine (`frame`, `bus`,
`scroll-owner`, `scroll-ease`, `chat-dom`).

Derived from there, rewritten for this package:

| Here | There |
| --- | --- |
| `src/reveal/{diff,engine,paint,text,params}.js` | `packages/client/src/features/chat-reveal/` |
| `src/follow/{follow,scroll-owner,scroll-ease,process-follow,chat-dom,ease}.js` | `packages/client/src/features/chat-follow/` and `packages/engine/src/` |
| `src/frame.js`, `src/bus.js` | `packages/engine/src/{frame,bus}.ts` |

What changed in the port: TypeScript to JavaScript; the theme's feature registry,
settings rows, stylesheet pipeline and skin-vocabulary rewriting removed, so the
package needs no theme; every mark renamed from `dsh-claude-*` to
`dsh-stream-motion*`; the two body gates split so a browser with only one of the
two APIs still gets the half it can run; the `::highlight()` rule subjects widened
from one descendant selector to two, so a container whose own text node is the
streamed text fades too; and the smoothed press added, which the original does
not have — there the back-to-end button still teleports.

New here, not derived: `package.json`, `cordis.patch.yml`, `src/host.js`,
`src/client.js`, `src/{motion,session,stylesheet,params}.js`, `build.mjs`,
`icon.svg`, `locale/`, and all four test harnesses.

The upstream MIT notice is reproduced in full in [LICENSE](LICENSE).

## License

MIT. Copyright (c) 2026 ybtou. Portions derived from dsh-claude-style,
Copyright (c) 2026 Nwflower, also MIT — see [LICENSE](LICENSE).
