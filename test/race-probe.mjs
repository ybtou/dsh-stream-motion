// The host and the plugin both react to the same growth, on their own clocks.
// The plugin slides only what it saw the host pin (`moved = scrollTop - previous`).
// If the host pins one frame later than the plugin's resize callback, the growth
// is never slid — and then the host's write shows up as a jump.
//
// This probe delays the host pin by one frame to see whether that race is real.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const HTTP_PORT = 43165
const CDP_PORT = 9385

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

const profile = await mkdtemp(join(tmpdir(), 'dsh-race-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=1200,800',
  '--disable-features=CalculateNativeWinOcclusion',
  `http://127.0.0.1:${HTTP_PORT}/test/harness.html`,
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
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
      return result.result.value
    } catch (error) {
      if (!/context|navigated/i.test(String(error))) throw error
      await sleep(250)
    }
  }
  throw new Error('evaluate never found a context')
}

for (let i = 0; i < 120; i += 1) {
  if (await evaluate('window.__ready === true || window.__bootError !== undefined')) break
  await sleep(500)
}
const bootError = await evaluate('window.__bootError ?? null')
if (bootError !== null) throw new Error(bootError)

const checks = []
function check(name, passed, detail) {
  checks.push({ name, passed, detail })
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
}

// Install a host pin that writes the end one frame after it measures the
// growth — the shape a host gets when its follow runs through a scheduler.
const setup = await evaluate(`(() => {
  for (let i = 0; i < 40; i += 1) window.__addBlock('history row ' + i)
  const marker = window.__addBlock('MARKER')
  marker.id = 'marker'
  const column = document.getElementById('column')
  const scroller = document.getElementById('scroll')
  scroller.scrollTop = scroller.scrollHeight

  let last = column.getBoundingClientRect().height
  let queued = 0
  let scheduled = false
  new ResizeObserver(() => {
    const height = column.getBoundingClientRect().height
    const grew = height - last
    last = height
    if (grew <= 0) return
    queued += grew
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      const pending = queued
      queued = 0
      scroller.scrollTop = scroller.scrollTop + pending
    })
  }).observe(column)
  return scroller.scrollTop
})()`)
await evaluate('window.__frame()')
await sleep(200)

await evaluate(`(() => {
  const scroll = document.getElementById('scroll')
  const marker = document.getElementById('marker')
  const column = document.getElementById('column')
  const samples = []
  let running = true
  const look = () => {
    if (!running) return
    samples.push({
      t: Math.round(performance.now()),
      top: Math.round((marker.getBoundingClientRect().top - scroll.getBoundingClientRect().top) * 100) / 100,
      tx: getComputedStyle(column).transform,
      st: Math.round(scroll.scrollTop * 100) / 100,
    })
    requestAnimationFrame(look)
  }
  requestAnimationFrame(look)
  window.__samples = samples
  window.__stop = () => { running = false; return samples }
  return true
})()`)

const PARAGRAPH = 'The quick brown fox jumps over the lazy dog while the model keeps writing a long summary of everything it has done so far. '
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
await sleep(500)
const samples = await evaluate('window.__stop()')

let previous = null
let backCount = 0
let worstBack = 0
const backs = []
for (const sample of samples) {
  if (previous !== null && sample.top - previous > 1) {
    backCount += 1
    worstBack = Math.max(worstBack, sample.top - previous)
    backs.push({ t: sample.t, rise: Math.round((sample.top - previous) * 100) / 100, tx: sample.tx, st: sample.st })
  }
  previous = sample.top
}

check('a frame-late host pin is a real race the plugin must survive', true, { chars: stream, frames: samples.length })
check('the flow never jumps back down under a frame-late pin', backCount === 0, {
  backCount,
  worstBack: Math.round(worstBack * 100) / 100,
  backs: backs.slice(0, 12),
})

const failed = checks.filter((entry) => !entry.passed)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) {
  console.log(JSON.stringify({ failed: failed.map((entry) => entry.name) }, null, 2))
  console.log('\n--- samples around the first back-jump ---')
  const at = backs[0]?.t ?? samples[0].t
  for (const s of samples.filter((x) => Math.abs(x.t - at) < 120)) {
    console.log(`t=${s.t} top=${s.top} tx=${s.tx} st=${s.st}`)
  }
}

socket.close()
chrome.kill()
server.close()
await sleep(400)
await rm(profile, { recursive: true, force: true }).catch(() => {})
process.exit(failed.length === 0 ? 0 : 1)
