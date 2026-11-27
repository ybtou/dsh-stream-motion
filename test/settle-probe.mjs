// Does the column jump when a settle is cut short?
//
// A settle eases the offset the column still carries back to zero. `runCarried`
// reads that offset back off the animation's clock, and it used to read every
// animation with GLIDE_EASE — the curve a slide paints with, not the one a settle
// does. The two curves are far apart early on: at a fifth of the way through, a
// glide has travelled 0.50 of its distance and a settle 0.19.
//
// This drives the exact sequence in the harness — slide, shrink, growth mid
// settle — and records the painted offset every frame, plus every animation the
// plugin makes or cancels on the column. A settle that is made and cancelled
// inside one task leaves no trace in the frame samples; only the ledger shows it.
//
//   node test/settle-probe.mjs

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const HTTP_PORT = 43161
const CDP_PORT = 9381

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

const profile = mkdtempSync(join(tmpdir(), 'dsh-settle-'))
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1200,800',
  '--disable-features=CalculateNativeWinOcclusion',
  `http://127.0.0.1:${HTTP_PORT}/?hostpin`,
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pageTarget() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page !== undefined) return page
    } catch { /* not listening yet */ }
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

  const report = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const scroll = document.getElementById('scroll')
    const column = document.getElementById('column')

    // The plugin reports a throwing frame task to the console rather than taking
    // the page down. A settle that asks an Animation for an animate of its own
    // throws there, and the offset it was meant to carry is lost in the same
    // callback — so the report is the evidence, not a symptom beside it.
    const thrown = []
    const nativeError = console.error
    console.error = (...args) => {
      thrown.push(args.map((one) => (one instanceof Error ? one.message : String(one))).join(' '))
      nativeError.apply(console, args)
    }

    const offset = () => {
      const matrix = getComputedStyle(column).transform
      if (matrix === 'none') return 0
      const parts = matrix.slice(matrix.indexOf('(') + 1, -1).split(',')
      const value = Number(parts[parts.length - 1])
      return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0
    }

    const samples = []
    const ledger = []
    let sampling = true
    let seq = 0

    const nativeAnimate = Element.prototype.animate
    // The offset the column carries at the moment its last animation was taken
    // away. A handover that keeps the distance starts the next animation exactly
    // there; one that does not starts somewhere else, and the difference is what
    // the reader sees as a step between two frames.
    let carriedAtCancel = null
    Element.prototype.animate = function (frames, timing) {
      const carried = this === column ? (carriedAtCancel ?? offset()) : null
      if (this === column) carriedAtCancel = null
      const animation = nativeAnimate.call(this, frames, timing)
      if (this !== column) return animation
      seq += 1
      const probeId = seq
      ledger.push({
        t: Math.round(performance.now()),
        what: 'made',
        id: probeId,
        carried,
        from: frames && frames[0] ? frames[0].transform : null,
        dur: timing ? timing.duration : null,
        ease: timing ? timing.easing : null,
      })
      const nativeCancel = animation.cancel.bind(animation)
      animation.cancel = () => {
        if (this === column) carriedAtCancel = offset()
        ledger.push({
          t: Math.round(performance.now()),
          what: 'cancel',
          id: probeId,
          carried: this === column ? carriedAtCancel : null,
          now: animation.currentTime === null ? null : Math.round(Number(animation.currentTime)),
          stack: String(new Error().stack).split('\\n').slice(1, 7).join(' / '),
        })
        return nativeCancel()
      }
      return animation
    }

    const tick = () => {
      if (!sampling) return
      const live = column.getAnimations().map((animation) => {
        const timing = animation.effect.getTiming()
        const keys = animation.effect.getKeyframes()
        return {
          from: keys[0] ? keys[0].transform : null,
          now: animation.currentTime === null ? null : Math.round(Number(animation.currentTime)),
          dur: timing.duration,
          ease: timing.easing,
          state: animation.playState,
        }
      })
      samples.push({
        t: Math.round(performance.now()),
        ty: offset(),
        y: Math.round(scroll.scrollTop * 100) / 100,
        h: scroll.scrollHeight,
        live,
      })
      requestAnimationFrame(tick)
    }

    for (let i = 0; i < 40; i += 1) window.__addBlock('filler ' + i)
    scroll.scrollTop = scroll.scrollHeight
    await frame()

    const answer = document.createElement('div')
    answer.setAttribute('data-streaming', '')
    answer.style.cssText = 'display:block;height:20px;overflow:hidden'
    column.appendChild(answer)
    await frame()
    await sleep(300)

    // The slide: one growth of 300px, pinned by the stand-in host. The probe
    // must not write scrollTop here — the stand-in host does it, and doing both
    // pins the same growth twice, which no build can compensate for.
    answer.style.height = '320px'
    requestAnimationFrame(tick)
    await frame()
    const slidAt = Math.round(performance.now())
    // Shrunk while the slide still carries most of its offset: a round boundary
    // arrives mid-glide, which is the case that needs a settle. Waiting for the
    // slide to finish would leave nothing to settle and test nothing.
    await sleep(45)

    const beforeShrink = offset()
    answer.style.height = '20px'
    await frame()
    const shrunkAt = Math.round(performance.now())
    await sleep(60)

    // A growth arriving a fifth of the way into the settle.
    const midSettle = offset()
    answer.style.height = '220px'
    await frame()
    const grewAt = Math.round(performance.now())
    await sleep(500)
    sampling = false
    const rest = offset()

    return { samples, ledger, thrown, slidAt, beforeShrink, shrunkAt, midSettle, grewAt, rest }
  })()`)

  if (report && report.__error !== undefined) {
    check('the sequence ran', false, report.__error)
  } else {
    const list = report.samples
    // The column's translateY only means something next to the scroll it is
    // compensating for. The host pins the scroller on every growth, which moves
    // scrollTop by the same amount it moves translateY, so a raw translateY step
    // reads as a jump where the reader saw the text stay still. What the reader
    // sees is the difference: how far the content is drawn from where the scroll
    // says it should be.
    const visual = (sample) => Math.round((sample.ty - sample.y) * 100) / 100
    // A reply only ever moves one way: the content sits below its final place and
    // rises to it. So the fault is not a fast frame — a glide covering 200 px
    // starts fast on purpose — it is a frame that moves the content back DOWN
    // after it had risen. That reversal is the twitch; its size is how visible it
    // is. Monotonic speed is reported, never failed.
    //
    // A frame whose scrollHeight changed is skipped: a collapse takes the tail
    // with it, the browser clamps scrollTop to the shorter content, and the
    // difference shows up as a large apparent move of everything above — which is
    // the probe's own edit, not the plugin.
    let worstBack = 0
    let worstBackAt = null
    let worstRise = 0
    let reversals = 0
    let skipped = 0
    let previousDirection = 0
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].h !== list[i - 1].h) {
        skipped += 1
        previousDirection = 0
        continue
      }
      const step = Math.round((visual(list[i]) - visual(list[i - 1])) * 100) / 100
      if (step > 0) {
        if (previousDirection < 0) reversals += 1
        if (step > worstBack) {
          worstBack = step
          worstBackAt = {
            t: list[i].t,
            from: visual(list[i - 1]),
            to: visual(list[i]),
            step,
            ty: [list[i - 1].ty, list[i].ty],
            y: [list[i - 1].y, list[i].y],
          }
        }
        previousDirection = 1
      } else if (step < 0) {
        previousDirection = -1
        if (-step > worstRise) worstRise = Math.round(-step * 100) / 100
      }
    }
    const near = (at, window) => list
      .filter((s) => Math.abs(s.t - at) <= window)
      .map((s) => `${s.t}:${s.ty}-${s.y}=${visual(s)}`)

    console.log(`\nslide began at t=${report.slidAt}`)
    console.log(`before shrink ty=${report.beforeShrink}, shrunk at t=${report.shrunkAt}`)
    console.log(`mid-settle ty=${report.midSettle}, growth at t=${report.grewAt}, rest ty=${report.rest}`)
    console.log(`worst backward step (content moved down): ${worstBack}px ${JSON.stringify(worstBackAt)}`)
    console.log(`direction reversals: ${reversals}   frames skipped (scrollHeight changed): ${skipped}`)
    console.log(`fastest single rise (a glide's own speed, not a fault): ${worstRise}px`)
    console.log(`frames around the shrink: ${near(report.shrunkAt, 110).join(' ')}`)
    console.log(`frames around the growth: ${near(report.grewAt, 110).join(' ')}`)

    console.log('\nledger on the column (first 24, then counts):')
    for (const step of report.ledger.slice(0, 24)) {
      const tail = step.what === 'made'
        ? `carried=${step.carried} from=${step.from} dur=${step.dur} ${step.ease}`
        : `carried=${step.carried} cancelled at now=${step.now}`
      console.log(`  ${step.t} ${step.what} #${step.id} ${tail}`)
    }
    const madeCount = report.ledger.filter((step) => step.what === 'made').length
    const cancelCount = report.ledger.filter((step) => step.what === 'cancel').length
    const settles = report.ledger.filter((step) => step.what === 'made' && /0\.33, 0, 0\.2, 1/.test(String(step.ease)))
    console.log(`  total: ${madeCount} made, ${cancelCount} cancelled, ${settles.length} settles`)

    console.log('\nanimations per frame:')
    for (const sample of list) {
      if (Math.abs(sample.t - report.shrunkAt) > 260 && Math.abs(sample.t - report.grewAt) > 260) continue
      const live = sample.live.map((a) => `${a.state} now=${a.now}/${a.dur} ${a.ease} ${a.from}`)
      console.log(`  ${sample.t} ty=${sample.ty}  ${live.length === 0 ? '(none)' : live.join(' | ')}`)
    }

    // A reply only ever travels one way: the content sits below its final place
    // and rises to it. A frame that moves it back down after it had risen is the
    // twitch the reader reports, and its size is how visible it is.
    check('the content never moves back down in a frame', worstBack <= 2, { worstBack, worstBackAt, reversals })

    // A shrink that arrives while the column still carries an offset has to hand
    // that offset to a settle. Building one is where an Animation was once asked
    // for an `animate` of its own; it threw, the catch in the frame loop kept the
    // page alive, and the offset went with it in one frame — so a run with a
    // shrink and no settle at all is the fault, whatever the frames look like
    // afterwards.
    const settlesMade = report.ledger.filter((step) => step.what === 'made' && /0\.33, 0, 0\.2, 1/.test(String(step.ease)))
    check('a shrink while an offset is carried makes a settle', settlesMade.length > 0, { settles: settlesMade.length })

    // Every animation taken away has to hand its offset to whatever replaces it.
    // The offset is how far the content is drawn from where the scroll says it
    // should be, so losing it between two frames lifts the text by that distance.
    // A cancel with nothing after it is the worst case: the offset was dropped
    // and no animation was made to carry it, which lands the column at rest in
    // one frame.
    const dropped = []
    for (let i = 0; i < report.ledger.length; i += 1) {
      const step = report.ledger[i]
      if (step.what !== 'cancel') continue
      const lost = Math.abs(step.carried ?? 0)
      if (lost <= 2) continue
      const next = report.ledger[i + 1]
      if (next === undefined) {
        dropped.push({ at: step.t, lost: step.carried, carriedBy: 'nothing — the column was left at rest' })
        continue
      }
      if (next.what !== 'made' || Math.abs((next.carried ?? 0) - (step.carried ?? 0)) > 1) {
        dropped.push({ at: step.t, lost: step.carried, carriedBy: `${next.what} at ${next.carried}`, from: next.from })
      }
    }
    check('every handover keeps the offset it took over', dropped.length === 0, dropped)
  }
} finally {
  try { ws?.close() } catch { /* already gone */ }
  server.close()
  chrome.kill()
  await sleep(1200)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* chrome may still hold it */ }
}

const failed = results.filter((one) => !one.passed)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
