// One real stream, measured: frame gaps, long tasks, and how many runs faded.
//
// Real streams vary in length, so a single pair of runs proves nothing; run this
// once per arm per round and compare medians. The frame clock is installed
// before any page script so the first frame is seen, and the run ends when the
// host's own `data-streaming` mark disappears.
//
//   node test/stream-ab.mjs [port] [label] [prompt]
//
// The arm is whatever the profile currently has: switch it with
// `plugin_manager set_bundle { target: 'dsh-stream-motion', enabled: false }`
// and put it back to true afterwards.

import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.argv[2] ?? 9580)
const LABEL = process.argv[3] ?? 'run'
const PROMPT = process.argv[4] ?? '用大约两百字介绍一下潮汐是怎么形成的。'
const OUT = join(import.meta.dirname, 'stream-ab.json')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const log = await readFile('C:\\Users\\alzc\\AppData\\Roaming\\dsh-tauri\\logs\\desktop\\dsh-web.log', 'utf8')
const urls = [...log.matchAll(/http:\/\/127\.0\.0\.1:3080\/\?token=[A-Za-z0-9_-]+/g)]
const url = urls[urls.length - 1][0]

const probe = `
  const rec = { frames: [], long: [], runs: 0, chars: 0, active: false, ended: false, peakChars: 0, batches: 0 }
  window.__rec = rec

  let last = performance.now()
  const tick = (now) => {
    const gap = now - last
    last = now
    if (rec.active) rec.frames.push(Math.round(gap * 10) / 10)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  new PerformanceObserver((list) => {
    if (!rec.active) return
    for (const entry of list.getEntries()) rec.long.push(Math.round(entry.duration))
  }).observe({ entryTypes: ['longtask'] })

  // The host marks the answer body itself: data-streaming on the markdown root.
  // Watching the attribute is enough; the content is read only to size the run.
  const watch = new MutationObserver(() => {
    const live = document.querySelectorAll('[data-streaming]')
    if (live.length > 0 && !rec.active && !rec.ended) {
      rec.active = true
      rec.startedAt = performance.now()
      return
    }
    if (rec.active) {
      // A real reply keeps streaming for many seconds and remounts its container
      // as it grows; one that starts and stops inside a second is a shell, not a
      // reply, and must not be recorded as an arm.
      rec.batches += 1
      let chars = 0
      for (const node of live) chars += (node.textContent || '').length
      rec.peakChars = Math.max(rec.peakChars, chars)
      rec.lastChars = chars
    }
    if (live.length === 0 && rec.active) {
      rec.active = false
      rec.ended = true
      rec.seconds = Math.round((performance.now() - rec.startedAt) / 100) / 10
    }
  })
  const begin = () => {
    if (document.body === null) { requestAnimationFrame(begin); return }
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-streaming'] })
  }
  begin()
`

const profile = await mkdtemp(join(tmpdir(), 'stream-ab-'))
// A headful window parked off screen is never composited, and its rAF runs
// uncapped — measured p50 3.3 ms, i.e. ~300 fps, so "frames over 50 ms" counts a
// population no reader ever sees. Headless keeps the 60 Hz clock, so the frame
// budget in the numbers is the one a reader actually has.
const HEADLESS = process.env.AB_HEADLESS === '1'
const flags = HEADLESS
  ? ['--headless=new', '--window-size=1400,900']
  : ['--window-position=-2400,-2400', '--window-size=1400,900', '--disable-features=CalculateNativeWinOcclusion']
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  ...flags,
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', url,
], { stdio: 'ignore' })

let page
for (let attempt = 0; attempt < 200; attempt += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    page = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
    if (page !== undefined) break
  } catch { /* not listening yet */ }
  await sleep(250)
}
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let nextId = 1
const pending = new Map()
socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  if (message.error !== undefined) entry.reject(new Error(message.error.message))
  else entry.resolve(message.result)
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId
  nextId += 1
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails !== undefined) return { __error: result.exceptionDetails.text }
  return result.result.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.addScriptToEvaluateOnNewDocument', { source: probe })
await send('Page.reload')
await sleep(3000)

// Open a conversation: the workspace panel is the only door to the session list,
// and the title button inside a row is the only thing that actually opens one.
const opened = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const workspaces = [...document.querySelectorAll('button, a, [role="button"]')].find((n) => (n.textContent || '').includes('会话与工作区'))
  if (workspaces) workspaces.click()
  await sleep(4000)
  const row = document.querySelector('.sm-rowTitleButton')
  if (row === null) return { ok: false, missing: 'no session row' }
  row.click()
  await sleep(6000)
  return { ok: document.querySelector('[data-chat-flow]') !== null, flows: document.querySelectorAll('[data-chat-flow]').length }
})()`)
console.log('opened:', JSON.stringify(opened))

// A new session, so the reply starts from an empty conversation.
const fresh = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const button = [...document.querySelectorAll('button, [role="button"]')].find((n) => /新建|新会话|new/i.test((n.textContent || '') + (n.getAttribute('aria-label') || '')))
  if (button) { button.click(); await sleep(2500) }
  const box = document.querySelector('[data-composer-card] [contenteditable="true"]')
  return { composer: box !== null }
})()`)
console.log('fresh:', JSON.stringify(fresh))

await evaluate(`document.querySelector('[data-composer-card] [contenteditable="true"]')?.focus()`)
await send('Input.insertText', { text: PROMPT })
await sleep(300)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })

let state
for (let attempt = 0; attempt < 240; attempt += 1) {
  await sleep(1000)
  state = await evaluate(`({
    active: window.__rec.active,
    ended: window.__rec.ended,
    frames: window.__rec.frames.length,
    seconds: window.__rec.seconds ?? 0,
    runs: document.querySelectorAll('[data-dsh-stream-motion-run]').length,
    streaming: document.querySelectorAll('[data-streaming]').length,
  })`)
  if (state?.ended === true) break
  if (attempt % 15 === 14) console.log('waiting:', JSON.stringify(state))
}

const raw = await evaluate(`(() => {
  const rec = window.__rec
  const frames = rec.frames.slice().sort((a, b) => a - b)
  const at = (share) => frames[Math.min(frames.length - 1, Math.floor(frames.length * share))] ?? 0
  return {
    seconds: rec.seconds ?? 0,
    batches: rec.batches,
    peakChars: rec.peakChars,
    runs: document.querySelectorAll('[data-dsh-stream-motion-run]').length,
    frames: { count: frames.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: frames[frames.length - 1] ?? 0,
      over32: frames.filter((g) => g > 32).length, over50: frames.filter((g) => g > 50).length, over100: frames.filter((g) => g > 100).length },
    longTasks: rec.long.length,
    longTaskTotal: rec.long.reduce((sum, v) => sum + v, 0),
    worstLong: rec.long.length === 0 ? 0 : Math.max(...rec.long),
    // Replies differ in length by a factor of four between runs, so the raw
    // counts are not comparable across arms. Per second is.
    perSecond: {
      over50: Math.round((frames.filter((g) => g > 50).length / Math.max(rec.seconds ?? 1, 0.1)) * 100) / 100,
      long: Math.round((rec.long.length / Math.max(rec.seconds ?? 1, 0.1)) * 100) / 100,
      longMs: Math.round((rec.long.reduce((sum, v) => sum + v, 0) / Math.max(rec.seconds ?? 1, 0.1)) * 10) / 10,
    },
  }
})()`)

console.log(`\n${LABEL} ${JSON.stringify(raw)}`)

let all = {}
try { all = JSON.parse(await readFile(OUT, 'utf8')) } catch { /* first run */ }
all[LABEL] = raw
await writeFile(OUT, JSON.stringify(all, null, 2))
console.log(`saved to ${OUT}`)

socket.close()
chrome.kill()
await sleep(1500)
try { await rm(profile, { recursive: true, force: true }) } catch { /* chrome may still hold it */ }
