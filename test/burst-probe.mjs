// What a single large commit does to the reader's view.
//
// A summarising model can hand the view a few thousand pixels in one commit.
// The slide carries at most SCROLL_EASE_LEAD_PX of it, so the question is
// whether the remainder is left as a visible shift, and whether the carried
// part then slides back — a jump up followed by a jump down.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const HTTP_PORT = 43163
const CDP_PORT = 9383

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

const profile = await mkdtemp(join(tmpdir(), 'dsh-burst-'))
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

await evaluate(`(() => {
  for (let i = 0; i < 40; i += 1) window.__addBlock('history row ' + i)
  const marker = window.__addBlock('MARKER')
  marker.id = 'marker'
  const scroll = document.getElementById('scroll')
  scroll.scrollTop = scroll.scrollHeight
  return scroll.scrollTop
})()`)
await evaluate('window.__frame()')
await sleep(150)

// One commit adds a long summary. Sized to exceed the slide's lead clamp so the
// question is answerable: 240 paragraphs of 8 lines is far past 1200 px.
const burst = await evaluate(`(async () => {
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
      scrollTop: Math.round(scroll.scrollTop),
    })
    requestAnimationFrame(look)
  }
  requestAnimationFrame(look)
  await window.__frame()

  const { answer } = window.__addStreaming('')
  const before = samples.at(-1).top
  const heightBefore = column.getBoundingClientRect().height
  answer.textContent = ('A long summary paragraph the model wrote in one commit, with plenty of characters in it. ').repeat(120)
  await window.__frame()
  await window.__frame()
  const grew = column.getBoundingClientRect().height - heightBefore
  await window.__sleep(600)
  running = false
  return { before, grew, samples }
})()`)

const samples = burst.samples
const first = samples[0].top
let worstBack = 0
let backCount = 0
let worstStep = 0
let previous = null
const backs = []
for (const sample of samples) {
  if (previous !== null) {
    const step = Math.abs(sample.top - previous)
    worstStep = Math.max(worstStep, step)
    if (sample.top - previous > 1) {
      backCount += 1
      worstBack = Math.max(worstBack, sample.top - previous)
      backs.push({ t: sample.t, rise: Math.round((sample.top - previous) * 100) / 100, tx: sample.tx })
    }
  }
  previous = sample.top
}
const last = samples.at(-1).top

check('one commit added well past the slide lead', burst.grew > 1200, { grew: Math.round(burst.grew) })
check('the flow followed the whole commit', Math.abs((first - last) - burst.grew) < 30, {
  first, last, grew: Math.round(burst.grew), travelled: Math.round((first - last) * 100) / 100,
})
check('a burst does not show a jump back down', backCount === 0, {
  backCount,
  worstBack: Math.round(worstBack * 100) / 100,
  backs: backs.slice(0, 10),
})
// A burst is too big to cross inside one frame, but the lead still spreads most
// of it over time: the single worst frame must stay well under the whole commit.
const movingFrames = samples.filter((s, i) => i > 0 && Math.abs(s.top - samples[i - 1].top) > 1).length
check('a burst is spread over many frames, not one', movingFrames >= 8 && worstStep < burst.grew * 0.5, {
  movingFrames, worstStep: Math.round(worstStep * 100) / 100,
})

const failed = checks.filter((entry) => !entry.passed)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) {
  console.log(JSON.stringify({ failed: failed.map((entry) => entry.name) }, null, 2))
  console.log('\n--- samples ---')
  for (const s of samples.slice(0, 26)) console.log(`t=${s.t} top=${s.top} tx=${s.tx} st=${s.scrollTop}`)
}

socket.close()
chrome.kill()
server.close()
await sleep(400)
await rm(profile, { recursive: true, force: true }).catch(() => {})
process.exit(failed.length === 0 ? 0 : 1)
