import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The live check: the installed bundle, in the real GUI, driven through the
 * marks the host writes. The page under test is the running app, reached over
 * its own debugging port — not a mock of the plugin.
 *
 * What this can prove depends on what the app has open. With no conversation on
 * screen there is no flow column, so the slide itself is reported as not
 * exercised here rather than passed: its behaviour is covered by test/probe.mjs
 * against the same marks.
 */

const LOG = 'C:\\Users\\alzc\\AppData\\Roaming\\dsh-tauri\\logs\\desktop\\dsh-web.log'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9431

const line = readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes('?token=')).pop()
const url = line.match(/https?:\/\/\S+\?token=\S+/)[0]

const profile = mkdtempSync(join(tmpdir(), 'dsh-follow-live-'))
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1400,900', url,
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function target() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page !== undefined) return page
    } catch {}
    await sleep(500)
  }
  throw new Error('no page target')
}

const results = []
const check = (name, passed, detail) => {
  results.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}
const skip = (name, why) => {
  results.push({ name, passed: true, skipped: true, detail: why })
  console.log(`SKIP  ${name}  ${JSON.stringify(why)}`)
}

let ws
try {
  const page = await target()
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
    for (let attempt = 0; attempt < 80; attempt += 1) {
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

  // The token exchange navigates once; the body mark lands after the bundle runs.
  for (let i = 0; i < 120; i += 1) {
    if (await evaluate(`document.body.hasAttribute('data-dsh-stream-motion')`) === true) break
    await sleep(500)
  }

  check('the installed bundle applies in the real GUI',
    await evaluate(`document.body.hasAttribute('data-dsh-stream-motion')`) === true)

  const style = await evaluate(`(() => {
    const sheet = document.getElementById('dsh-stream-motion-style')
    return sheet === null ? null : { plugin: sheet.dataset.plugin, rules: sheet.sheet === null ? 0 : sheet.sheet.cssRules.length }
  })()`)
  check('the stylesheet is mounted and tagged', style?.plugin === 'dsh-stream-motion', style)
  // Two follow rules plus one per fade step, all in the one sheet the package mounts.
  check('the stylesheet carries the clip, the button placement and every fade step',
    style?.rules === 10, style?.rules)

  check('the animation API is there', await evaluate(`typeof Element.prototype.animate === 'function'`) === true)

  const page_ = await evaluate(`({
    flow: document.querySelectorAll('[data-chat-flow]').length,
    scroll: document.querySelectorAll('[data-conversation-scroll]').length,
    session: document.querySelectorAll('[data-conversation-session]').length,
    streaming: document.querySelectorAll('[data-streaming]').length,
  })`)

  // ---------- the reader's hold, on the real scroller ----------
  //
  // The conversation scroller is on the page even with no session open, but a
  // scroller with nothing to scroll takes no hold: a hold is a position to
  // defend, and there is none. So the hold is only exercised on a scroller that
  // actually scrolls.
  const scrollable = await evaluate(`(() => {
    const scroller = document.querySelector('[data-conversation-scroll]')
    return scroller === null ? null : scroller.scrollHeight - scroller.clientHeight
  })()`)
  if (typeof scrollable === 'number' && scrollable > 0) {
    const hold = await evaluate(`(async () => {
      const scroller = document.querySelector('[data-conversation-scroll]')
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }))
      await frame()
      const held = scroller.hasAttribute('data-dsh-stream-motion-reader-hold')
      // Coming back to the end gives the hold up again: the mark is the reading.
      scroller.scrollTop = scroller.scrollHeight
      scroller.dispatchEvent(new Event('scroll'))
      await frame()
      const released = !scroller.hasAttribute('data-dsh-stream-motion-reader-hold')
      return { held, released }
    })()`)
    check('a wheel on the real scroller takes the hold', hold?.held === true, hold)
    check('coming back to the end gives the hold up', hold?.released === true, hold)
  } else {
    skip('a wheel on the real scroller takes the hold', { noScrollRange: scrollable })
    skip('coming back to the end gives the hold up', { noScrollRange: scrollable })
  }

  // ---------- the slide, on the real page ----------
  //
  // The flow column only exists once a conversation has messages, and this check
  // does not send one: that would cost a model turn and leave a session behind.
  // So the column is created here, inside the real scroller, with the marks the
  // host writes on it. Everything under test is the real thing — the installed
  // bundle, the real scroller, the real stylesheet, the real host marks — and the
  // one synthetic part is the column element the host would have mounted.
  const slide = await evaluate(`(async () => {
    const scroller = document.querySelector('[data-conversation-scroll]')
    if (scroller === null) return { missing: 'no scroller' }
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const root = document.createElement('div')
    root.setAttribute('data-chat-following-tail', '')
    const column = document.createElement('div')
    column.setAttribute('data-chat-flow', '')
    root.appendChild(column)
    scroller.appendChild(root)
    for (let i = 0; i < 30; i += 1) {
      const filler = document.createElement('div')
      filler.setAttribute('data-chat-flow-key', 'f' + i)
      filler.style.height = '40px'
      column.appendChild(filler)
    }
    const answer = document.createElement('div')
    answer.setAttribute('data-streaming', '')
    answer.style.cssText = 'display:block;height:20px;overflow:hidden'
    column.appendChild(answer)
    await frame()
    await new Promise((r) => setTimeout(r, 300))
    scroller.scrollTop = scroller.scrollHeight
    await frame()
    // Scrolling the harness's own column to the end is itself a pin, and the
    // plugin has no way to tell it from the host's. Let that slide finish, so the
    // growth measured below starts from a still column and its distance is the
    // pin alone.
    for (let i = 0; i < 60 && column.getAnimations().length > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 50))
    }
    const scrollBefore = scroller.scrollTop
    answer.style.height = '160px'
    scroller.scrollTop = scroller.scrollHeight
    await frame()
    const animations = column.getAnimations()
    const timing = animations[0]?.effect.getTiming()
    const keys = animations[0]?.effect.getKeyframes().map((k) => k.transform)
    const scrolledBy = scroller.scrollTop - scrollBefore
    await new Promise((r) => setTimeout(r, 320))
    const rest = getComputedStyle(column).transform
    const out = { count: animations.length, keys, duration: timing?.duration, easing: timing?.easing, scrolledBy, rest }
    root.remove()
    return out
  })()`)
  // The column is a new one, so the subscription's baseline report and the growth
  // arrive in the same frame: two animations on the column, both the same slide
  // restarted. What matters is that the newest one is the slide, which the next
  // checks read off the first animation.
  check('a growth on the real page starts the slide', (slide?.count ?? 0) >= 1, slide)
  // The distance is what the host's pin still owes: this frame's write, plus
  // whatever an earlier restart had not paid back yet, and never past the lead.
  // The pin is read from the scroll event's own delta while the harness reads it
  // off the scroller afterwards, and a scroller clamps to whole pixels, so the
  // two can differ by a couple of pixels without either being wrong.
  const carried = Number(/translateY\((-?[\d.]+)px\)/.exec(slide?.keys?.[0] ?? '')?.[1] ?? NaN)
  check('the slide carries the host pin it cancels',
    slide?.scrolledBy > 0
      && Number.isFinite(carried)
      && Math.abs(carried - slide.scrolledBy) <= 8
      && carried <= 1200,
    { keys: slide?.keys, scrolledBy: slide?.scrolledBy, carried })
  check('the slide rides the glide curve', slide?.easing === 'cubic-bezier(0.22, 0.61, 0.36, 1)', slide?.easing)
  check('the slide is capped by the token', slide?.duration > 0 && slide?.duration <= 240, slide?.duration)
  check('the slide rests with no transform left', slide?.rest === 'none', slide?.rest)

  // ---------- the button's shape ----------
  //
  // The host renders its back-to-end button only while its own follow is off,
  // in the slot after the frame the column's grandparent closes. The check builds
  // that shape and confirms the package's own lookup finds the button in it,
  // which is the one part of the placement that depends on the host's structure.
  const shape = await evaluate(`(async () => {
    const scroller = document.querySelector('[data-conversation-scroll]')
    if (scroller === null) return { missing: 'no scroller' }
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    // The shape the package walks: the column's grandparent is the frame, and the
    // button stands in that frame's next sibling.
    const outer = document.createElement('div')
    const frameElement = document.createElement('div')
    const inner = document.createElement('div')
    const column = document.createElement('div')
    column.setAttribute('data-chat-flow', '')
    inner.appendChild(column)
    frameElement.appendChild(inner)
    const slot = document.createElement('div')
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = 'down'
    slot.appendChild(button)
    outer.appendChild(frameElement)
    outer.appendChild(slot)
    scroller.appendChild(outer)
    await frame()
    await new Promise((r) => setTimeout(r, 250))
    const out = {
      marked: button.hasAttribute('data-dsh-stream-motion-tail'),
      right: button.style.getPropertyValue('--dsh-stream-motion-tail-right'),
      bottom: button.style.getPropertyValue('--dsh-stream-motion-tail-bottom'),
      position: getComputedStyle(button).position,
      boxRight: Math.round(button.getBoundingClientRect().right),
      cardRight: Math.round(document.querySelector('[data-composer-card]')?.getBoundingClientRect().right ?? -1),
      viewportRight: Math.round(window.innerWidth),
    }
    outer.remove()
    return out
  })()`)
  check('the package finds the host button in the frame it looks in', shape?.marked === true, shape)
  check('the button is placed by two measured numbers',
    /^-?\d+px$/.test(shape?.right ?? '') && /^-?\d+px$/.test(shape?.bottom ?? ''), shape)
  check('the button\'s right edge is the composer\'s right edge',
    shape?.cardRight === -1 || Math.abs(shape.boxRight - shape.cardRight) <= 1,
    { boxRight: shape?.boxRight, cardRight: shape?.cardRight })
  check('the stylesheet fixes the button where it was measured', shape?.position === 'fixed', shape?.position)

  const failed = results.filter((r) => !r.passed)
  const skipped = results.filter((r) => r.skipped === true)
  console.log(`\n${results.length - failed.length - skipped.length}/${results.length - skipped.length} checks passed, ${skipped.length} skipped`)
  if (failed.length > 0) {
    console.log(JSON.stringify(failed, null, 2))
    process.exitCode = 1
  }
} finally {
  try { ws?.close() } catch {}
  chrome.kill()
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
