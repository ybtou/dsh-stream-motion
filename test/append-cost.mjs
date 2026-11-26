// When an append dirties the tree, who pays to resolve style?
//
// Real streams vary in length, so arms measured on them overlap and prove
// nothing. This drives a fixed number of appends at a fixed rate into a real
// streaming container on the real page, and runs the same batches three ways on
// the same page: read style inside the mutation callback, push that read to
// requestAnimationFrame, or drop the callback altogether. Callback time and
// frame gaps are recorded together, because a cost paid in a callback and one
// paid by the frame itself look identical to a callback timer.
//
// Measured: reading in the callback costs ~50-75 ms a time; the same read in
// rAF costs ~0.05-1 ms, and the frame gaps of that arm match the dropped arm —
// so the cost goes away rather than moving into the frame.

import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.argv[2] ?? 9560)
const OUT = join(import.meta.dirname, 'append-cost.json')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const log = await readFile('C:\\Users\\alzc\\AppData\\Roaming\\dsh-tauri\\logs\\desktop\\dsh-web.log', 'utf8')
const urls = [...log.matchAll(/http:\/\/127\.0\.0\.1:3080\/\?token=[A-Za-z0-9_-]+/g)]
const url = urls[urls.length - 1][0]

// Arms differ only in how the theme callback is scheduled.
const ARMS = ['per-append', 'per-frame', 'dropped']

const probe = `
  const cost = { theme: [], rects: 0, rectMs: 0, styleCalls: 0, styleMs: 0, active: false, frames: [] }
  window.__cost = cost
  window.__themeObservers = 0

  // Frame gaps during the arm: a forced style recalculation paid inside an
  // observer callback and one paid by the frame itself look the same in a
  // callback timer, and only the frame clock tells them apart.
  let lastFrame = performance.now()
  const tick = (now) => {
    const gap = now - lastFrame
    lastFrame = now
    if (cost.active) cost.frames.push(Math.round(gap * 10) / 10)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  const nativeStyle = window.getComputedStyle
  window.getComputedStyle = function (element, pseudo) {
    if (!cost.active) return nativeStyle.call(window, element, pseudo)
    const started = performance.now()
    const value = nativeStyle.call(window, element, pseudo)
    cost.styleCalls += 1
    cost.styleMs += performance.now() - started
    return value
  }

  const nativeRect = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function () {
    if (!cost.active) return nativeRect.call(this)
    const started = performance.now()
    const value = nativeRect.call(this)
    cost.rects += 1
    cost.rectMs += performance.now() - started
    return value
  }

  const Native = window.MutationObserver
  window.__timed = 0
  window.__pending = []
  class Timed extends Native {
    constructor(callback, ...rest) {
      const theme = String(callback).includes('smApplyTheme')
      if (theme) window.__themeObservers += 1
      let frame = 0
      super(function (records, observer) {
        if (!theme || !cost.active) return callback.call(this, records, observer)
        window.__timed += 1
        const mode = window.__mode
        if (mode === 'dropped') return undefined
        if (mode === 'per-frame') {
          window.__pending = records
          if (frame !== 0) return undefined
          frame = requestAnimationFrame(() => {
            frame = 0
            const started = performance.now()
            callback.call(observer, window.__pending, observer)
            cost.theme.push(Math.round((performance.now() - started) * 100) / 100)
          })
          return undefined
        }
        const started = performance.now()
        const result = callback.call(this, records, observer)
        cost.theme.push(Math.round((performance.now() - started) * 100) / 100)
        return result
      }, ...rest)
    }
  }
  window.MutationObserver = Timed
`

const profile = await mkdtemp(join(tmpdir(), 'append-cost-'))
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--window-position=-2400,-2400', '--window-size=1400,900',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-features=CalculateNativeWinOcclusion', url,
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
  if (result.exceptionDetails !== undefined) return { __error: result.exceptionDetails.text, detail: result.exceptionDetails.exception?.description }
  return result.result.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.addScriptToEvaluateOnNewDocument', { source: probe })
await send('Page.reload')
await sleep(3000)

// Get a chat flow on screen and the theme observer mounted at the same time.
// The order matters: the workspace panel has to be opened once to mount the
// observer, and a session has to be opened to have a flow to append to, but the
// panel covers the flow while it is open — so it is opened first and closed
// again, leaving the observer behind.
await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const workspaces = [...document.querySelectorAll('button, a, [role="button"]')].find((n) => (n.textContent || '').includes('会话与工作区'))
  if (workspaces) workspaces.click()
  await sleep(4000)
  const mounted = window.__themeObservers
  const row = document.querySelector('.sm-rowTitleButton')
  if (row !== null) row.click()
  await sleep(6000)
  const close = document.querySelector('[aria-label*="关闭"], [title*="关闭"]')
  if (close !== null) close.click()
  await sleep(3000)
  return { mounted, afterClose: window.__themeObservers, flows: document.querySelectorAll('[data-chat-flow]').length, nodes: document.querySelectorAll('*').length }
})()`).then((state) => console.log('page:', JSON.stringify(state)))

// One arm: append 240 batches at a fixed cadence into a real flow, measure.
const runArm = async (mode, batches, gapMs) => {
  return await evaluate(`(async () => {
    window.__mode = ${JSON.stringify(mode)}
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const flow = document.querySelector('[data-chat-flow]')
    if (flow === null) {
      // The panel replaces the chat view. Close it and wait for a flow to mount.
      const close = document.querySelector('[aria-label*="关闭"], [title*="关闭"]')
      if (close !== null) close.click()
      await sleep(3000)
    }
    const target = document.querySelector('[data-chat-flow]')
    if (target === null) return { error: 'no flow', themeObservers: window.__themeObservers }
    const answer = document.createElement('div')
    answer.setAttribute('data-streaming', '')
    answer.innerHTML = '<p></p>'
    answer.firstChild.appendChild(document.createTextNode(''))
    target.appendChild(answer)
    await sleep(200)
    const cost = window.__cost
    cost.theme.length = 0
    cost.frames.length = 0
    cost.rects = 0; cost.rectMs = 0; cost.styleCalls = 0; cost.styleMs = 0
    window.__timed = 0
    cost.active = true
    const node = answer.firstChild
    for (let batch = 0; batch < ${batches}; batch += 1) {
      // An element per batch, not a bare text node: the theme observer watches
      // childList, and the host's markdown layer mounts elements as tokens
      // arrive. Text alone never dirties style, so a text-node load measures a
      // style read that was already clean — 2 ms for 1920 calls, against 43 ms
      // per call on a real stream. The element is what makes the read pay.
      const span = document.createElement('span')
      span.textContent = 'abcdefgh'
      node.appendChild(span)
      await sleep(${gapMs})
    }
    await sleep(600)
    cost.active = false
    answer.removeAttribute('data-streaming')
    await sleep(300)
    answer.remove()
    const list = cost.theme.slice().sort((a, b) => a - b)
    const at = (share) => list[Math.min(list.length - 1, Math.floor(list.length * share))] ?? 0
    const gaps = cost.frames.slice().sort((a, b) => a - b)
    const frameAt = (share) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * share))] ?? 0
    return {
      mode: ${JSON.stringify(mode)},
      batches: ${batches},
      gapMs: ${gapMs},
      callbacks: window.__timed,
      themeCalls: list.length,
      themeTotal: Math.round(list.reduce((sum, v) => sum + v, 0) * 10) / 10,
      themeP50: at(0.5),
      themeP95: at(0.95),
      themeMax: list[list.length - 1] ?? 0,
      frames: { count: gaps.length, p50: frameAt(0.5), p95: frameAt(0.95), max: gaps[gaps.length - 1] ?? 0, over50: gaps.filter((g) => g > 50).length },
      styleCalls: cost.styleCalls,
      styleMs: Math.round(cost.styleMs * 10) / 10,
      rects: cost.rects,
      rectMs: Math.round(cost.rectMs * 10) / 10,
    }
  })()`)
}

const results = {}
for (const mode of ARMS) {
  // Two cadences: one append per frame (16 ms) and three per frame (5 ms).
  for (const gapMs of [16, 5]) {
    const result = await runArm(mode, 240, gapMs)
    const key = `${mode}@${gapMs}ms`
    results[key] = result
    console.log(key.padEnd(20), JSON.stringify(result))
  }
}

console.log('\nsummary:')
for (const [key, value] of Object.entries(results)) {
  if (value.error !== undefined) { console.log(key, value.error); continue }
  console.log(`${key.padEnd(20)} callbacks ${String(value.callbacks).padStart(4)}  themeCalls ${String(value.themeCalls).padStart(4)}  themeTotal ${String(value.themeTotal).padStart(8)}ms  p95 ${String(value.themeP95).padStart(6)}  styleCalls ${String(value.styleCalls).padStart(4)}  styleMs ${String(value.styleMs).padStart(7)}`)
}

let all = {}
try { all = JSON.parse(await readFile(OUT, 'utf8')) } catch { /* first run */ }
all[new Date().toISOString()] = results
await writeFile(OUT, JSON.stringify(all, null, 2))
console.log(`saved to ${OUT}`)

socket.close()
chrome.kill()
await sleep(1500)
try { await rm(profile, { recursive: true, force: true }) } catch { /* chrome may still hold it */ }
