// Measures visible vertical jitter while a long answer streams.
//
// A fixed marker block sits above the streaming answer. Its distance from the
// scroller's top edge is the reader's view of the flow: while following, that
// number only ever shrinks (content rises) or holds. Any rise is a visible jump
// back down, which is what the reader reports as shaking.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const HTTP_PORT = 43157
const CDP_PORT = 9377

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${HTTP_PORT}`)
  const path = url.pathname === '/' ? '/test/harness.html' : url.pathname
  try {
    const body = await readFile(join(ROOT, path))
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end('not found')
  }
})
await new Promise((done) => server.listen(HTTP_PORT, '127.0.0.1', done))

const profile = await mkdtemp(join(tmpdir(), 'dsh-jitter-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=1200,800',
  '--disable-features=CalculateNativeWinOcclusion',
  `http://127.0.0.1:${HTTP_PORT}/test/harness.html?hostpin`,
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function pageTarget() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
      if (page) return page
    } catch {}
    await sleep(250)
  }
  throw new Error('no page target')
}

const target = await pageTarget()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((done, fail) => {
  socket.addEventListener('open', done, { once: true })
  socket.addEventListener('error', fail, { once: true })
})

let nextId = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  if (message.error) entry.fail(new Error(JSON.stringify(message.error)))
  else entry.done(message.result)
})

function send(method, params) {
  const id = (nextId += 1)
  return new Promise((done, fail) => {
    pending.set(id, { done, fail })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ' ' + JSON.stringify(result.exceptionDetails.exception?.description ?? ''))
      return result.result.value
    } catch (error) {
      if (!/context|navigated/i.test(String(error))) throw error
      await sleep(250)
    }
  }
  throw new Error('evaluate never found a context')
}

for (let i = 0; i < 120; i += 1) {
  const ready = await evaluate('window.__ready === true || window.__bootError !== undefined')
  if (ready) break
  await sleep(500)
}
const bootError = await evaluate('window.__bootError ?? null')
if (bootError !== null) throw new Error(bootError)

const checks = []
function check(name, passed, detail) {
  checks.push({ name, passed, detail })
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
}

// Fill the scroller so the flow has real range, then mark a fixed reference
// block. Everything above it is history the reader is not looking at.
await evaluate(`(() => {
  for (let i = 0; i < 40; i += 1) window.__addBlock('history row ' + i)
  const marker = window.__addBlock('MARKER')
  marker.id = 'marker'
  window.__sleep = window.__sleep
  return document.getElementById('scroll').scrollHeight
})()`)

await evaluate(`(() => {
  const scroll = document.getElementById('scroll')
  scroll.scrollTop = scroll.scrollHeight
  return scroll.scrollTop
})()`)
await evaluate('window.__frame()')

// Sampler: records, once per frame, the marker's offset from the scroller top
// and the column's live transform. Runs inside the page so nothing is lost to
// round-trip latency.
await evaluate(`(() => {
  const scroll = document.getElementById('scroll')
  const marker = document.getElementById('marker')
  const column = document.getElementById('column')
  const samples = []
  let running = true
  const look = () => {
    if (!running) return
    const markerTop = marker.getBoundingClientRect().top - scroll.getBoundingClientRect().top
    const transform = getComputedStyle(column).transform
    const animations = column.getAnimations().map((a) => ({
      playState: a.playState,
      currentTime: typeof a.currentTime === 'number' ? Math.round(a.currentTime) : null,
      duration: a.effect?.getTiming?.().duration ?? null,
    }))
    samples.push({ t: Math.round(performance.now()), markerTop: Math.round(markerTop * 100) / 100, transform, animations, scrollTop: scroll.scrollTop })
    requestAnimationFrame(look)
  }
  requestAnimationFrame(look)
  window.__samples = samples
  window.__stopSampling = () => { running = false; return samples }
  return true
})()`)

// Stream a long answer the way a summarising model writes one: many small
// pieces, close together, with a few longer ones.
const PARAGRAPH = 'The quick brown fox jumps over the lazy dog while the model keeps writing a long summary of everything it has done so far, and the reader watches the text arrive. '
// The host's follow pins by the growth it measured, not by re-reading the end:
// `scrollTop += delta` lands on the same pixel the content moved, while
// `scrollTop = scrollHeight` lands wherever the clamp happens to put it. Only
// the delta form tells us whether the plugin jitters under a correct pin.
const stream = await evaluate(`(async () => {
  const { answer } = window.__addStreaming('')
  const paragraph = ${JSON.stringify(PARAGRAPH)}
  let written = ''
  let fed = 0
  while (written.length < 2600) {
    const piece = paragraph.slice(fed % paragraph.length, (fed % paragraph.length) + 4 + (fed % 5))
    written += piece
    fed += piece.length
    answer.textContent = written
    await window.__frame()
    await window.__sleep(8)
  }
  return written.length
})()`)

await evaluate('window.__frame()')
await sleep(600)
const samples = await evaluate('window.__stopSampling()')

// A follow that only ever moves content up has a non-increasing markerTop.
// The tolerance absorbs sub-pixel layout rounding, not a visible jump.
const TOLERANCE = 1
let worstBack = 0
let backCount = 0
let previous = null
const backSteps = []
for (const sample of samples) {
  if (previous !== null) {
    const rise = sample.markerTop - previous
    if (rise > TOLERANCE) {
      backCount += 1
      worstBack = Math.max(worstBack, rise)
      backSteps.push({ t: sample.t, rise: Math.round(rise * 100) / 100, transform: sample.transform, animations: sample.animations.length })
    }
  }
  previous = sample.markerTop
}

const first = samples[0]?.markerTop ?? null
const last = samples.at(-1)?.markerTop ?? null
const totalRise = first !== null && last !== null ? Math.round((last - first) * 100) / 100 : null
const animatedFrames = samples.filter((s) => s.animations.length > 0).length

check('the answer streamed a long body', stream > 2500, { chars: stream, frames: samples.length })
check('the flow follows downward as text arrives', totalRise !== null && totalRise < -200, { first, last, totalRise })
check('the flow never jumps back down', backCount === 0, {
  backCount,
  worstBack: Math.round(worstBack * 100) / 100,
  firstBacks: backSteps.slice(0, 12),
})
check('the slide animation actually runs during the stream', animatedFrames > 0, { animatedFrames, frames: samples.length })

const failed = checks.filter((entry) => !entry.passed)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) {
  console.log(JSON.stringify({ failed: failed.map((entry) => entry.name) }, null, 2))
  const dump = samples.map((s) => `${s.t} top=${s.markerTop} tx=${s.transform} anim=${s.animations.length}`).join('\n')
  console.log('\n--- samples ---\n' + dump)
}

socket.close()
chrome.kill()
server.close()
// Chrome's crashpad writes a metrics file it may still hold for a moment after
// the process is signalled; the temporary profile is worth neither a retry loop
// nor a failure, so its removal is best effort.
await sleep(400)
await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
process.exit(failed.length === 0 ? 0 : 1)
