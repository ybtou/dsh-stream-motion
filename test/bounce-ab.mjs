// Does the column jump during a real stream, and in which direction?
//
// The slide paints the flow column at translateY(distance) and rises to 0. Two
// things can show up as a jump: a cancel that lands the column at 0 in one frame
// (an upward snap the eye reads as the text leaping), and a restart whose
// distance is larger than the one still carried (a downward snap). This records
// the column's painted offset every frame next to the scroll position, so both
// are measured on the real page during a real reply rather than inferred.
//
//   node test/bounce-ab.mjs [port] [label] [prompt]

import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.argv[2] ?? 9620)
const LABEL = process.argv[3] ?? 'bounce'
const PROMPT = process.argv[4] ?? '请写一篇大约一千五百字的技术说明，讲清楚浏览器渲染流水线里样式重算、布局、绘制与合成的分工，以及哪些操作会让流水线从头开始。'
const OUT = join(import.meta.dirname, 'bounce-ab.json')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const log = await readFile('C:\\Users\\alzc\\AppData\\Roaming\\dsh-tauri\\logs\\desktop\\dsh-web.log', 'utf8')
const urls = [...log.matchAll(/http:\/\/127\.0\.0\.1:3080\/\?token=[A-Za-z0-9_-]+/g)]
const url = urls[urls.length - 1][0]

const probe = `
  const rec = { samples: [], active: false, ended: false, events: [], cancels: [], boundaries: [] }
  window.__bounce = rec

  const column = () => document.querySelector('[data-chat-flow]')
  const scroller = () => document.querySelector('[data-conversation-scroll]')

  // The painted offset, not the animation's declared one: this is what the eye
  // sees, and it is the only number that can show a cancel.
  const offsetOf = (element) => {
    if (element === null) return null
    const matrix = window.getComputedStyle(element).transform
    if (matrix === 'none') return 0
    const parts = matrix.slice(matrix.indexOf('(') + 1, -1).split(',')
    const value = Number(parts[parts.length - 1])
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : null
  }

  // A cancel is the one move no animation explains: the animation disappears
  // while it still had distance to pay. Watching getAnimations() is the only way
  // to see it, because the painted value afterwards is simply 0.
  let seen = new Map()
  const trackAnimations = (flow) => {
    if (flow === null) return
    const live = new Set()
    for (const animation of flow.getAnimations()) {
      live.add(animation)
      const timing = animation.effect?.getComputedTiming?.()
      const now = Number(animation.currentTime)
      seen.set(animation, { now, duration: timing?.duration ?? 0 })
    }
    for (const [animation, last] of seen) {
      if (live.has(animation)) continue
      seen.delete(animation)
      if (!rec.active) continue
      // Gone before its own duration ran out: the offset it still carried was
      // dropped in one frame rather than eased away.
      const left = last.duration - last.now
      if (left > 8) rec.cancels.push({ t: Math.round(performance.now()), left: Math.round(left) })
    }
  }

  let lastFrame = performance.now()
  const tick = (now) => {
    const gap = now - lastFrame
    lastFrame = now
    if (rec.active) {
      const flow = column()
      const box = scroller()
      trackAnimations(flow)
      rec.samples.push({
        t: Math.round(now),
        gap: Math.round(gap * 10) / 10,
        ty: offsetOf(flow),
        y: box === null ? null : Math.round(box.scrollTop * 10) / 10,
        h: box === null ? null : box.scrollHeight,
        pinned: flow === null ? null : flow.closest('[data-chat-following-tail]') !== null,
      })
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  new PerformanceObserver((list) => {
    if (!rec.active) return
    for (const entry of list.getEntries()) rec.events.push({ t: Math.round(entry.startTime), long: Math.round(entry.duration) })
  }).observe({ entryTypes: ['longtask'] })

  const watch = new MutationObserver(() => {
    const live = document.querySelectorAll('[data-streaming]')
    if (live.length > 0 && !rec.active && !rec.ended) { rec.active = true; rec.startedAt = performance.now(); return }
    if (live.length === 0 && rec.active) {
      rec.active = false
      rec.ended = true
      rec.seconds = Math.round((performance.now() - rec.startedAt) / 100) / 10
    }
  })

  // The structural moments the slide stops on: a thinking row leaving running,
  // and the live turn's row leaving the tree. If a snap lines up with one of
  // these, that stop is what the eye sees.
  const boundaryWatch = new MutationObserver((records) => {
    if (!rec.active) return
    for (const record of records) {
      if (record.type === 'attributes' && record.attributeName === 'data-phase') {
        const before = record.oldValue
        const after = record.target.getAttribute('data-phase')
        if (before === 'running' && after !== 'running') rec.boundaries.push({ t: Math.round(performance.now()), what: 'phase-left-running' })
        continue
      }
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue
        if (node.matches('[data-chat-running]') || node.querySelector('[data-chat-running]') !== null) {
          rec.boundaries.push({ t: Math.round(performance.now()), what: 'running-row-removed' })
        }
      }
    }
  })

  const begin = () => {
    if (document.body === null) { requestAnimationFrame(begin); return }
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-streaming'] })
    boundaryWatch.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['data-phase'], attributeOldValue: true,
    })
  }
  begin()
`

const profile = await mkdtemp(join(tmpdir(), 'bounce-ab-'))
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--window-size=1400,900',
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

const fresh = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const button = [...document.querySelectorAll('button, [role="button"]')].find((n) => /新建|新会话|new/i.test((n.textContent || '') + (n.getAttribute('aria-label') || '')))
  if (button) { button.click(); await sleep(2500) }
  return { composer: document.querySelector('[data-composer-card] [contenteditable="true"]') !== null }
})()`)
console.log('fresh:', JSON.stringify(fresh))

await evaluate(`document.querySelector('[data-composer-card] [contenteditable="true"]')?.focus()`)
await send('Input.insertText', { text: PROMPT })
await sleep(300)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })

for (let attempt = 0; attempt < 240; attempt += 1) {
  await sleep(1000)
  const state = await evaluate(`({ active: window.__bounce.active, ended: window.__bounce.ended, n: window.__bounce.samples.length })`)
  if (state?.ended === true) break
}

const report = await evaluate(`(() => {
  const rec = window.__bounce
  const list = rec.samples
  const downs = []
  const ups = []
  const visual = []
  for (let index = 1; index < list.length; index += 1) {
    const before = list[index - 1]
    const after = list[index]
    if (before.ty === null || after.ty === null) continue
    const step = Math.round((after.ty - before.ty) * 100) / 100
    // A move worth seeing: more than two pixels in one frame.
    if (step > 2) downs.push({ t: after.t, step, from: before.ty, to: after.ty })
    if (step < -2) ups.push({ t: after.t, step, from: before.ty, to: after.ty })
    // What the eye actually tracks: the column's offset against the scroll. A
    // translateY that grows by exactly the scrollTop increase holds the content
    // still, so only this composite can tell a real jump from a compensated pin.
    // Normalised to a 16.7 ms frame: headless runs rAF at ~300 Hz here, so a raw
    // per-frame step understates a move the reader would see in one 60 Hz frame.
    if (before.y === null || after.y === null) continue
    const seen = (after.ty - after.y) - (before.ty - before.y)
    const perFrame = after.gap > 0 ? (seen / after.gap) * 16.7 : seen
    if (Math.abs(perFrame) > 2) visual.push({ t: after.t, step: Math.round(perFrame * 100) / 100, ty: after.ty, y: after.y, h: after.h, gap: after.gap })
  }
  const withOffset = list.filter((s) => s.ty !== null && s.ty !== 0).length
  const near = (list, at, window) => list.filter((one) => Math.abs(one.t - at) <= window)
  const ySteps = []
  for (let index = 1; index < list.length; index += 1) {
    const before = list[index - 1]
    const after = list[index]
    if (before.y === null || after.y === null) continue
    const step = Math.round((after.y - before.y) * 10) / 10
    if (Math.abs(step) > 2) ySteps.push({ t: after.t, step })
  }
  const snaps = visual.filter((move) => move.step < -2 && near(rec.cancels, move.t, 60).length > 0)
  return {
    seconds: rec.seconds ?? 0,
    samples: list.length,
    framesWithOffset: withOffset,
    rawDown: downs.length,
    rawUp: ups.length,
    // The only numbers that describe what a reader sees.
    visualJumps: visual.length,
    visualDown: visual.filter((m) => m.step > 0).length,
    visualUp: visual.filter((m) => m.step < 0).length,
    worstVisualDown: visual.length === 0 ? 0 : Math.max(0, ...visual.map((m) => m.step)),
    worstVisualUp: visual.length === 0 ? 0 : Math.min(0, ...visual.map((m) => m.step)),
    biggestVisual: visual.sort((a, b) => Math.abs(b.step) - Math.abs(a.step)).slice(0, 10),
    cancels: rec.cancels.length,
    cancelsWithDistance: rec.cancels.filter((c) => c.left > 20).length,
    biggestCancels: rec.cancels.sort((a, b) => b.left - a.left).slice(0, 8),
    snaps: snaps.length,
    biggestSnaps: snaps.sort((a, b) => a.step - b.step).slice(0, 8),
    boundaries: rec.boundaries.length,
    boundaryList: rec.boundaries.slice(0, 12),
    scrollJumps: ySteps.length,
    worstScroll: ySteps.length === 0 ? 0 : Math.max(...ySteps.map((m) => Math.abs(m.step))),
    longTasks: rec.events.length,
    trace: list.filter((s) => s.ty !== 0 && s.ty !== null).slice(0, 40),
  }
})()`)

console.log(`\n${LABEL} ${JSON.stringify({ ...report, trace: undefined }, null, 2)}`)
console.log('first offsets:', JSON.stringify(report.trace))

let all = {}
try { all = JSON.parse(await readFile(OUT, 'utf8')) } catch { /* first run */ }
all[LABEL] = report
await writeFile(OUT, JSON.stringify(all, null, 2))
console.log(`saved to ${OUT}`)

socket.close()
chrome.kill()
await sleep(1500)
try { await rm(profile, { recursive: true, force: true }) } catch { /* chrome may still hold it */ }
