# Third-party notice

Portions of this software are derived from **dsh-claude-style**
(https://github.com/nwflower/dsh-claude-style), Copyright (c) 2026 Nwflower,
released under the MIT License. The full upstream notice is reproduced at the
bottom of this file.

## What was derived

| Here | There |
| --- | --- |
| `src/reveal/{diff,engine,paint,text,params}.js` | `packages/client/src/features/chat-reveal/` |
| `src/follow/{follow,scroll-owner,scroll-ease,process-follow,chat-dom,ease}.js` | `packages/client/src/features/chat-follow/` and `packages/engine/src/` |
| `src/follow/fold-glide.js` | `packages/client/src/features/chat-fold/{fold-glide,fold-glide-parts}.ts` |
| `src/frame.js`, `src/bus.js` | `packages/engine/src/{frame,bus}.ts` |

## What changed in the port

- TypeScript to JavaScript.
- The theme's feature registry, settings rows, stylesheet pipeline and
  skin-vocabulary rewriting were removed, so this package needs no theme.
- Every mark was renamed from `dsh-claude-*` to `dsh-stream-motion*`.
- The two body gates were split, so a browser with only one of the two APIs
  still gets the half it can run.
- The `::highlight()` rule subjects were widened from one descendant selector
  to two, so a container whose own text node is the streamed text fades too.
- The smoothed press was added. The original does not have it: there the
  back-to-end button still teleports.
- The slide is additive (`composite: 'add'`, one animation per piece of growth)
  and is started from the scroller's scroll event rather than from the size
  batch. The original restarts one replace-mode animation per growth, which
  snaps the painted offset back to the restart's computed value and shows as a
  bounce when the host's own write lands a frame away from the size report.
- The door glide reads the body from the root's own children when a control
  names no `aria-controls`, so the disclosure shape without one is covered too.
- The door glide was narrowed to the disclosure row and to a tool group that is
  actually capped. The original also carries the theme's message fold, process
  summary and reasoning stream; those were not ported, and a tool group without
  a height cap is left to the host instead of being animated to its own height.

## What is original to this package

`package.json`, `cordis.patch.yml`, `src/host.js`, `src/client.js`,
`src/{motion,session,stylesheet,params}.js`, `build.mjs`, `icon.svg`,
`locale/`, and all nine test harnesses plus the two live suites.

## Upstream notice

```
MIT License

Copyright (c) 2026 Nwflower

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

dsh-claude-style carries further notices that do not apply here, because no
part of them was copied: a PolyForm Shield licence on its Sodium rendering
engine (`packages/client/src/features/sodium/`,
`packages/engine/src/sheet-rewrite.ts`), and proprietary notices on the
Anthropic fonts and the Clawd artwork under `packages/assets/`.
