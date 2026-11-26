import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const HTTP_PORT = 43153
const CDP_PORT = 9373

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const path = url.pathname === '/' ? '/test/harness.html' : url.pathname
  const file = join(ROOT, path)
  if (!file.startsWith(ROOT) || !existsSync(file)) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise((done) => server.listen(HTTP_PORT, '127.0.0.1', done))

const profile = mkdtempSync(join(tmpdir(), 'dsh-follow-'))
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1200,800',
  '--disable-features=CalculateNativeWinOcclusion',
  `http://127.0.0.1:${HTTP_PORT}/`,
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pageTarget() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page !== undefined) return page
    } catch {}
    await sleep(250)
  }
  throw new Error('no page target')
}

const results = []
const check = (name, passed, detail) => {
  results.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}

let ws
try {
  const page = await pageTarget()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  let id = 0
  const waiting = new Map()
  ws.addEventListener('message', (ev) => {
    const message = JSON.parse(ev.data)
    const slot = waiting.get(message.id)
    if (slot === undefined) return
    waiting.delete(message.id)
    if (message.error) slot.reject(new Error(JSON.stringify(message.error)))
    else slot.resolve(message.result)
  })

  const evaluate = async (expression) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const reply = await new Promise((res, rej) => {
          const n = ++id
          waiting.set(n, { resolve: res, reject: rej })
          ws.send(JSON.stringify({
            id: n,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise: true, userGesture: true },
          }))
        })
        if (reply.exceptionDetails !== undefined) {
          return { __error: `${reply.exceptionDetails.text} ${reply.exceptionDetails.exception?.description ?? ''}` }
        }
        return reply.result.value
      } catch (error) {
        if (!/context|navigated/i.test(String(error.message))) throw error
        await sleep(250)
      }
    }
    throw new Error(`evaluate never found a context: ${expression.slice(0, 80)}`)
  }

  for (let i = 0; i < 60; i += 1) {
    if (await evaluate('window.__ready === true || window.__bootError !== undefined') === true) break
    await sleep(200)
  }

  const bootError = await evaluate('window.__bootError ?? null')
  check('bundle applies in the harness loader', bootError === null, bootError ?? undefined)
  check('package id is the bundle id', await evaluate('window.__applied.id') === 'dsh-stream-motion')
  check('body is marked by the package', await evaluate(`document.body.hasAttribute('data-dsh-stream-motion')`) === true)
  check('stylesheet mounted and tagged', await evaluate(`(() => {
    const sheet = document.getElementById('dsh-stream-motion-style')
    return sheet === null ? null : sheet.dataset.plugin
  })()`) === 'dsh-stream-motion')

  // ---------- the slide ----------
  //
  // A streaming answer grows the column; the host pins the end in the same
  // batch, so the scroller's position moves by the growth. The slide puts the
  // column back down by that much and glides it to rest on the compositor: what
  // the reader is looking at does not move, and no position is written.
  await evaluate(`(() => {
    const scroll = document.getElementById('scroll')
    for (let i = 0; i < 40; i += 1) window.__addBlock('filler ' + i)
    scroll.scrollTop = scroll.scrollHeight
    return scroll.scrollHeight
  })()`)
  await evaluate('window.__frame()')

  const slide = await evaluate(`(async () => {
    const scroll = document.getElementById('scroll')
    const column = document.getElementById('column')
    const answer = document.createElement('div')
    answer.setAttribute('data-streaming', '')
    answer.style.cssText = 'display:block;height:20px;overflow:hidden'
    column.appendChild(answer)
    // Let the resize subscription take its baseline at this height before the
    // growth: the pace the slide is timed to is read off two growths, and a
    // first frame with no gap would time it to nothing.
    await window.__frame()
    await window.__sleep(300)
    const startTop = column.getBoundingClientRect().top
    const scrollBefore = scroll.scrollTop
    answer.style.height = '160px'
    scroll.scrollTop = scroll.scrollHeight
    await window.__frame()
    const animations = column.getAnimations()
    const keys = animations[0]?.effect.getKeyframes().map((k) => k.transform)
    const timing = animations[0]?.effect.getTiming()
    const movedTop = column.getBoundingClientRect().top
    const scrolledBy = scroll.scrollTop - scrollBefore
    await window.__sleep(320)
    return {
      startTop,
      movedTop,
      scrolledBy,
      restTop: column.getBoundingClientRect().top,
      count: animations.length,
      keys,
      duration: timing?.duration,
      easing: timing?.easing,
      restTransform: getComputedStyle(column).transform,
    }
  })()`)

  check('the growth starts a slide on the column', slide.count === 1, slide.count)
  check('the slide is a replace-style translateY back to zero',
    slide.keys?.length === 2
      && /^translateY\(\d+(\.\d+)?px\)$/.test(slide.keys[0])
      && slide.keys[1] === 'translateY(0px)',
    slide.keys)
  check('the slide travels on the glide curve', slide.easing === 'cubic-bezier(0.22, 0.61, 0.36, 1)', slide.easing)
  check('the slide is capped by the slide token', slide.duration > 0 && slide.duration <= 240, slide.duration)
  check('the slide starts from exactly the host pin it cancels',
    slide.keys?.[0] === `translateY(${slide.scrolledBy}px)`,
    { keys: slide.keys, scrolledBy: slide.scrolledBy })
  check('the slide rests with no transform left', slide.restTransform === 'none', slide.restTransform)

  // ---------- the counter-slide ----------
  //
  // The live turn's row is pinned to the scroller's bottom and would ride the
  // column's offset, so it gets the same slide reversed in the same frame.
  const counter = await evaluate(`(async () => {
    const scroll = document.getElementById('scroll')
    const column = document.getElementById('column')
    const running = document.createElement('div')
    running.setAttribute('data-chat-running', '')
    running.style.height = '10px'
    column.appendChild(running)
    await window.__frame()
    await window.__sleep(300)
    const answer = column.querySelector('[data-streaming]')
    answer.style.height = '220px'
    scroll.scrollTop = scroll.scrollHeight
    await window.__frame()
    const own = column.getAnimations()
    const theirs = running.getAnimations()
    const frames = theirs[0]?.effect.getKeyframes().map((k) => k.transform)
    const sameStart = own[0] !== undefined && theirs[0] !== undefined
      && Math.abs(Number(own[0].startTime) - Number(theirs[0].startTime)) <= 1
    await window.__sleep(320)
    return { column: own.length, counter: theirs.length, frames, sameStart }
  })()`)
  check('the running row gets a counter-slide', counter.counter === 1, counter)
  check('the counter-slide starts in the same frame as the column slide', counter.sameStart === true, counter.sameStart)
  check('the counter-slide travels the other way',
    /^translateY\(-\d+(\.\d+)?px\)$/.test(counter.frames?.[0] ?? '') && counter.frames?.[1] === 'translateY(0px)',
    counter.frames)

  // ---------- the reader's hold ----------
  //
  // A wheel inside the scroller takes the hold: the slide stands down, and the
  // position the reader held is put back under the growth.
  const hold = await evaluate(`(async () => {
    const scroll = document.getElementById('scroll')
    const column = document.getElementById('column')
    scroll.scrollTop = 0
    await window.__frame()
    scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }))
    await window.__frame()
    const held = scroll.hasAttribute('data-dsh-stream-motion-reader-hold')
    const heldTop = scroll.scrollTop
    const answer = column.querySelector('[data-streaming]')
    answer.style.height = '260px'
    await window.__frame()
    await window.__sleep(120)
    return { held, heldTop, afterTop: scroll.scrollTop, animations: column.getAnimations().length }
  })()`)
  check('a wheel inside the scroller takes the reader hold', hold.held === true, hold.held)
  check('a held conversation is not slid', hold.animations === 0, hold.animations)
  check('the held position survives the growth', Math.abs(hold.afterTop - hold.heldTop) <= 1,
    { heldTop: hold.heldTop, afterTop: hold.afterTop })

  // ---------- the hand-back ----------
  //
  // The host turns its follow off on any write inside its sampling window and
  // leaves one way back: the button it renders only while off. The guard hands
  // the follow back by pressing it.
  const handBack = await evaluate(`(async () => {
    const root = document.getElementById('root')
    const slot = document.getElementById('toBottomSlot')
    const button = document.getElementById('toBottom')
    let pressed = 0
    button.addEventListener('click', () => {
      pressed += 1
      root.setAttribute('data-chat-following-tail', '')
      slot.hidden = true
    })
    // A reader who scrolled up and came back down: the wheel takes the hold, and
    // the scroll that lands at the end gives it back. This is the shape the
    // hand-back exists for — the host's own follow was written off by that travel.
    const scroll = document.getElementById('scroll')
    scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }))
    await window.__frame()
    scroll.scrollTop = scroll.scrollHeight
    scroll.dispatchEvent(new Event('scroll'))
    await window.__frame()
    await window.__sleep(50)
    const heldAfterScroll = scroll.hasAttribute('data-dsh-stream-motion-reader-hold')
    // The host turns its follow off: the attribute leaves, the button mounts.
    root.removeAttribute('data-chat-following-tail')
    slot.hidden = false
    await window.__sleep(700)
    return { pressed, heldAfterScroll, following: root.hasAttribute('data-chat-following-tail') }
  })()`)
  check('the guard presses the host back-to-end button', handBack.pressed >= 1, handBack.pressed)
  check('the follow comes back on the host', handBack.following === true)

  // ---------- the button's placement ----------
  //
  // Measured inside one frame of showing the button: the harness's stand-in host
  // hides the slot again as soon as the guard hands the follow back, so a longer
  // wait would measure a button that is already gone.
  const placement = await evaluate(`(async () => {
    const root = document.getElementById('root')
    const slot = document.getElementById('toBottomSlot')
    const button = document.getElementById('toBottom')
    root.removeAttribute('data-chat-following-tail')
    slot.hidden = false
    await window.__frame()
    const box = button.getBoundingClientRect()
    const cardBox = document.getElementById('composer').getBoundingClientRect()
    return {
      marked: button.hasAttribute('data-dsh-stream-motion-tail'),
      right: button.style.getPropertyValue('--dsh-stream-motion-tail-right'),
      bottom: button.style.getPropertyValue('--dsh-stream-motion-tail-bottom'),
      position: getComputedStyle(button).position,
      // Where the button actually landed against the composer's own edges.
      gapRight: Math.round(window.innerWidth - box.right),
      gapAbove: Math.round(cardBox.top - box.bottom),
      cardRightGap: Math.round(window.innerWidth - cardBox.right),
    }
  })()`)
  check('the host button is marked for the stylesheet', placement.marked === true, placement.marked)
  check('the button is placed by two measured numbers',
    /^-?\d+px$/.test(placement.right ?? '') && /^-?\d+px$/.test(placement.bottom ?? ''), placement)
  check('the stylesheet fixes the button where it was measured', placement.position === 'fixed', placement.position)
  check('the button stands at the composer top-right corner',
    Math.abs(placement.gapRight - placement.cardRightGap) <= 1 && placement.gapAbove > 0 && placement.gapAbove < 40,
    { gapRight: placement.gapRight, cardRightGap: placement.cardRightGap, gapAbove: placement.gapAbove })

  // ---------- the process catch-up ----------
  //
  // A capped process body that falls more than the threshold behind is walked to
  // its end on the spring.
  const process = await evaluate(`(async () => {
    const column = document.getElementById('column')
    const row = document.createElement('div')
    row.setAttribute('data-chat-flow-key', 'process')
    const body = document.createElement('div')
    body.setAttribute('data-step-process-body', '')
    body.style.cssText = 'height:120px;overflow-y:auto;overflow-x:hidden;display:block'
    const content = document.createElement('div')
    content.setAttribute('data-step-process-content', '')
    content.style.cssText = 'height:40px;display:block'
    body.appendChild(content)
    row.appendChild(body)
    column.appendChild(row)
    await window.__frame()
    await window.__sleep(120)
    body.scrollTop = 0
    content.style.height = '900px'
    await window.__sleep(900)
    return {
      top: body.scrollTop,
      floor: body.scrollHeight - body.clientHeight,
      overflowX: getComputedStyle(body).overflowX,
    }
  })()`)
  check('a capped process body is walked to its end',
    process.floor > 0 && Math.abs(process.top - process.floor) <= 2, process)
  check('the capped body is clipped sideways, not scrollable', process.overflowX === 'hidden', process.overflowX)

  // ---------- teardown ----------
  const teardown = await evaluate(`(() => {
    window.__applied.dispose()
    return {
      body: document.body.hasAttribute('data-dsh-stream-motion'),
      style: document.getElementById('dsh-stream-motion-style') !== null,
      tail: document.querySelector('[data-dsh-stream-motion-tail]') !== null,
      hold: document.querySelector('[data-dsh-stream-motion-hold]') !== null,
      readerHold: document.querySelector('[data-dsh-stream-motion-reader-hold]') !== null,
      animations: document.getAnimations().length,
    }
  })()`)
  check('teardown takes the body mark off', teardown.body === false)
  check('teardown removes the stylesheet', teardown.style === false)
  check('teardown takes every mark off',
    teardown.tail === false && teardown.hold === false && teardown.readerHold === false, teardown)

  const failed = results.filter((r) => !r.passed)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log(JSON.stringify(failed, null, 2))
    process.exitCode = 1
  }
} finally {
  try { ws?.close() } catch {}
  chrome.kill()
  server.close()
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
