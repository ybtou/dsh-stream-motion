import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, resolve } from 'node:path'

/**
 * The tail press: the host's back-to-end button must walk the position to the
 * end on the spring instead of writing it in one frame.
 */

const ROOT = resolve(import.meta.dirname, '..')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const HTTP_PORT = 43155
const CDP_PORT = 9375
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' }

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const path = url.pathname === '/' ? '/test/harness.html' : url.pathname
  const file = join(ROOT, path)
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404).end('no'); return }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise((d) => server.listen(HTTP_PORT, '127.0.0.1', d))

const profile = mkdtempSync(join(tmpdir(), 'tail-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1200,800', `http://127.0.0.1:${HTTP_PORT}/`], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let target = null
for (let i = 0; i < 60; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (target) break
  } catch {}
  await sleep(250)
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const waiting = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const s = waiting.get(m.id)
  if (s) { waiting.delete(m.id); s(m) }
})
const ev = (expression) => new Promise((res) => {
  const n = ++id
  waiting.set(n, (m) => res(m.result?.result?.value ?? m.result?.exceptionDetails ?? m))
  ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true, userGesture: true } }))
})
for (let i = 0; i < 60; i += 1) {
  if (await ev('window.__ready === true') === true) break
  await sleep(200)
}

const results = []
const check = (name, passed, detail) => {
  results.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}

// Fill the column, take the reader away from the tail, mount the host's button
// where the host mounts it, and press it.
const press = await ev(`(async () => {
  const scroll = document.getElementById('scroll')
  const column = document.getElementById('column')
  const slot = document.getElementById('toBottomSlot')
  const button = document.getElementById('toBottom')
  for (let i = 0; i < 60; i += 1) window.__addBlock('filler ' + i)
  await window.__frame()
  const root = document.getElementById('root')
  // The reader goes up: the host's follow is off and the button is on the page.
  scroll.scrollTop = 0
  root.removeAttribute('data-chat-following-tail')
  slot.hidden = false
  await window.__frame()
  await window.__sleep(100)

  // What the host's own handler would do: the jump it exists for. It is told
  // when it ran, so the checks can tell the reader's press (taken, so the host
  // never hears it) from the hand-back's own press on arrival (which must reach
  // the host, because that is what turns its follow back on).
  const hostHandlerAt = []
  button.addEventListener('click', () => { hostHandlerAt.push(Math.round(performance.now() - started)) })

  const samples = []
  const started = performance.now()
  button.click()
  // Sample the position every frame: a jump is one frame to the end, a walk is many.
  const sample = () => {
    samples.push({ t: Math.round(performance.now() - started), top: Math.round(scroll.scrollTop) })
    if (performance.now() - started < 1800) requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)
  await window.__sleep(1900)
  return {
    samples,
    floor: scroll.scrollHeight - scroll.clientHeight,
    hostHandlerAt,
    duration: performance.now() - started,
  }
})()`)

const tops = press.samples.map((s) => s.top)
const distinct = new Set(tops).size
const last = tops[tops.length - 1]
const first = tops[0]
const mid = press.samples.find((s) => s.top > 0 && s.top < press.floor)
// The arrival is the first frame the position stands at the end. The hand-back's
// own press lands after that, so a host handler heard before the arrival would
// mean the reader's press went through and the jump happened.
const arrivalAt = press.samples.find((s) => s.top >= press.floor - 2)?.t ?? Infinity
const earlyPress = press.hostHandlerAt.filter((t) => t < arrivalAt)

check('the reader press never reaches the host jump handler', earlyPress.length === 0,
  { hostHandlerAt: press.hostHandlerAt, arrivalAt })
check('the position ends at the conversation end', Math.abs(last - press.floor) <= 2,
  { last, floor: press.floor })
check('the position is walked, not written in one frame', distinct >= 4,
  { distinctFrames: distinct, frames: press.samples.length })
check('the walk begins near where the reader was, not at the end', first < press.floor / 4,
  { first, floor: press.floor })
check('the walk passes through the middle', mid !== undefined, mid)
// The curve: distance per frame rises then falls. A linear walk would hold one
// speed; a spring would start fast and only slow. This is the shape asked for.
const speeds = []
for (let i = 1; i < press.samples.length; i += 1) {
  const dt = press.samples[i].t - press.samples[i - 1].t
  if (dt <= 0) continue
  const dy = press.samples[i].top - press.samples[i - 1].top
  if (press.samples[i].top >= press.floor - 1) break
  speeds.push(dy / dt)
}
const peakAt = speeds.indexOf(Math.max(...speeds))
check('the travel speeds up before it slows down',
  speeds.length > 6 && peakAt > 0 && peakAt < speeds.length - 1,
  { peakAt, of: speeds.length, head: speeds.slice(0, 3).map((v) => Math.round(v * 1000) / 1000), peak: Math.round(Math.max(...speeds) * 1000) / 1000, tail: speeds.slice(-3).map((v) => Math.round(v * 1000) / 1000) })

const failed = results.filter((r) => !r.passed)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log(JSON.stringify({ failed, samples: press.samples.slice(0, 20) }, null, 2))
  process.exitCode = 1
}
ws.close(); chrome.kill(); server.close()
try { rmSync(profile, { recursive: true, force: true }) } catch {}
