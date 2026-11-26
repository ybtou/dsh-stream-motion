#!/usr/bin/env node
/**
 * Drive the bundle in a real Chromium over CDP and report what the page did.
 *
 * Everything here is observed: the step table's contents, the ranges each step
 * holds right after characters arrive, whether they clear once the fade ends,
 * and whether a container that was already on the page is left alone. Nothing is
 * asserted from the source; a failure names the observation that failed.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const PORT = 43151
const DEBUG_PORT = 9371

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(candidate => fs.existsSync(candidate))
if (CHROME === undefined) throw new Error('probe: no Chromium found')

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
const server = createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`)
  const relative = url.pathname === '/' ? 'test/harness.html' : url.pathname.slice(1)
  const file = path.join(ROOT, relative)
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    response.writeHead(404).end('not found')
    return
  }
  response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(response)
})
await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve))

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reveal-probe-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  `http://127.0.0.1:${PORT}/`,
], { stdio: 'ignore' })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** The page target's debugger socket, once Chrome has one. */
async function pageSocket() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find(target => target.type === 'page' && target.url.includes(String(PORT)))
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(100)
  }
  throw new Error('probe: Chrome never offered a page target')
}

const socket = new WebSocket(await pageSocket())
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })

let nextId = 1
const pending = new Map()
socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(message.error.message))
  else entry.resolve(message.result)
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId
  nextId += 1
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})

/** Evaluate in the page and return its JSON value; a thrown page error is reported as one. */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(`page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
  return result.result.value
}

await send('Runtime.enable')
await send('Page.enable')

const report = { checks: [] }
const check = (name, passed, detail) => {
  report.checks.push({ name, passed, detail })
}

/** Wait for the page's own install to have finished. */
for (let attempt = 0; attempt < 100; attempt += 1) {
  if (await evaluate('window.__ready === true')) break
  await sleep(50)
}

// 1. The plugin installed and left its marks.
report.install = await evaluate(`(() => {
  const sheet = document.getElementById('dsh-stream-motion-style')
  // Comments are stripped first: the merged sheet carries a section comment
  // before its first rule, and it would count as a subject of its own.
  const css = (sheet?.textContent ?? '').replace(/\\/\\*[\\s\\S]*?\\*\\//g, '')
  // Each step is one rule with two subjects, so the distinct names are counted,
  // not the number of times the pseudo-element appears.
  const steps = new Set(css.match(/::highlight\\(([^)]+)\\)/g) ?? [])
  const subjects = new Set(css.match(/[^,{}]+::highlight\\(/g)?.map(part => part.trim()) ?? [])
  return {
    bodyAttr: document.body.hasAttribute('data-dsh-stream-motion'),
    styleId: sheet !== null,
    stylePluginTag: sheet?.dataset.plugin ?? null,
    stepNames: steps.size,
    subjects: [...subjects],
    highlights: typeof CSS.highlights === 'object' && CSS.highlights !== null,
  }
})()`)
check('body carries the gate attribute', report.install.bodyAttr === true, report.install.bodyAttr)
check('one step rule per step', report.install.stepNames === 8, report.install.stepNames)
check('the sheet is tagged with the package name', report.install.stylePluginTag === 'dsh-stream-motion', report.install.stylePluginTag)
check('both text positions are covered as subjects', report.install.subjects.length === 2, report.install.subjects)

// 2. A container already on the page is history: it must not fade.
report.historyOnInstall = await evaluate(`(() => {
  const history = document.getElementById('history')
  const names = []
  for (let step = 0; step < 8; step += 1) {
    const highlight = CSS.highlights.get('dsh-stream-motion-tok-' + step)
    if (highlight !== undefined && highlight.size > 0) names.push(step)
  }
  return { fadedSteps: names, runAttr: history.querySelector('*') === null && history.hasAttribute('data-dsh-stream-motion-run') }
})()`)
check('text present at install does not fade', report.historyOnInstall.fadedSteps.length === 0, report.historyOnInstall.fadedSteps)

// 3. Stream characters into a fresh container and sample the step table.
report.streaming = await evaluate(`(async () => {
  const answer = document.getElementById('answer')
  answer.setAttribute('data-streaming', '')
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const sample = () => {
    const steps = []
    let ranges = 0
    for (let step = 0; step < 8; step += 1) {
      const highlight = CSS.highlights.get('dsh-stream-motion-tok-' + step)
      if (highlight !== undefined && highlight.size > 0) { steps.push(step); ranges += highlight.size }
    }
    return { steps, ranges }
  }
  const text = document.createTextNode('')
  answer.appendChild(text)
  await wait(40)
  // The first characters arrive one batch at a time, the way a stream delivers them.
  const samples = []
  for (const chunk of ['Hel', 'lo ', 'world']) {
    text.data += chunk
    await wait(30)
    samples.push({ chunk, ...sample() })
  }
  const runAttr = answer.closest('[data-dsh-stream-motion-run]') !== null
    || answer.querySelector('[data-dsh-stream-motion-run]') !== null
  const colorVar = answer.style.getPropertyValue('--dsh-stream-motion-run-color')
    || answer.querySelector('[data-dsh-stream-motion-run]')?.style.getPropertyValue('--dsh-stream-motion-run-color')
    || null
  // Past the fade and the paint loop's own retirement: every highlight must be empty.
  await wait(600)
  const settled = sample()
  return { samples, runAttr, colorVar, settled }
})()`)
const faded = report.streaming.samples.filter(sample => sample.ranges > 0)
check('characters that arrive are painted at a faint step', faded.length === report.streaming.samples.length, report.streaming.samples)
check('the faintest step is used, not the brightest', faded.some(sample => sample.steps.includes(0)), faded.map(s => s.steps))
check('the element carrying the text is marked as the rule subject', report.streaming.runAttr === true, report.streaming.runAttr)
check('the element published its own colour', typeof report.streaming.colorVar === 'string' && report.streaming.colorVar.length > 0, report.streaming.colorVar)
check('every highlight is empty once the fade ends', report.streaming.settled.ranges === 0, report.streaming.settled)

// 4. A small rewrite fades (the stream closing a marker), a whole-block one does not.
report.rewrite = await evaluate(`(async () => {
  const answer = document.getElementById('answer')
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const count = () => {
    let ranges = 0
    for (let step = 0; step < 8; step += 1) {
      const highlight = CSS.highlights.get('dsh-stream-motion-tok-' + step)
      if (highlight !== undefined) ranges += highlight.size
    }
    return ranges
  }
  await wait(500)
  // The markdown layer closing a marker: a couple of characters change in place.
  answer.textContent = 'Hello world'
  await wait(500)
  answer.textContent = 'Hello *world*'
  await wait(40)
  const afterMarker = count()
  await wait(500)
  // A final re-layout: the whole body is replaced with different text, far more
  // than the local-rewrite limit, so the reader must not watch it fade again.
  const replacement = 'a completely different paragraph of text that is long enough to pass the local rewrite limit'
  answer.textContent = replacement
  await wait(40)
  return { afterMarker, afterBlockRewrite: count(), replacementLength: replacement.length }
})()`)
check('a marker closing in place fades the characters that changed', report.rewrite.afterMarker > 0, report.rewrite.afterMarker)
check('a whole-block rewrite does not fade again', report.rewrite.afterBlockRewrite === 0, report.rewrite)

// 5. Text nested below the container fades too (a markdown body, not a bare div).
report.nested = await evaluate(`(async () => {
  const host = document.getElementById('conversation')
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const wrapper = document.createElement('div')
  wrapper.setAttribute('data-streaming', '')
  const body = document.createElement('div')
  body.className = 'body'
  const paragraph = document.createElement('p')
  paragraph.appendChild(document.createTextNode(''))
  body.appendChild(paragraph)
  wrapper.appendChild(body)
  host.appendChild(wrapper)
  await wait(40)
  const count = () => {
    let ranges = 0
    for (let step = 0; step < 8; step += 1) {
      const highlight = CSS.highlights.get('dsh-stream-motion-tok-' + step)
      if (highlight !== undefined) ranges += highlight.size
    }
    return ranges
  }
  paragraph.firstChild.data = 'nested'
  await wait(40)
  const painted = count()
  const marked = paragraph.hasAttribute('data-dsh-stream-motion-run')
  await wait(600)
  wrapper.remove()
  return { painted, marked, settled: count() }
})()`)
check('text below the container is painted', report.nested.painted > 0, report.nested.painted)
check('the element carrying nested text is marked', report.nested.marked === true, report.nested.marked)
check('nested text clears once its fade ends', report.nested.settled === 0, report.nested.settled)

// 6. Folding is not new text: the click guard must keep the reveal quiet.
report.fold = await evaluate(`(async () => {
  const answer = document.getElementById('answer')
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  await wait(400)
  answer.textContent = 'summary'
  await wait(500)
  const count = () => {
    let ranges = 0
    for (let step = 0; step < 8; step += 1) {
      const highlight = CSS.highlights.get('dsh-stream-motion-tok-' + step)
      if (highlight !== undefined) ranges += highlight.size
    }
    return ranges
  }
  // What a reader's fold looks like: a click, then the container's text expands.
  answer.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  answer.textContent = 'summary and the detail that was folded away'
  await wait(40)
  return { afterFold: count() }
})()`)
check('a fold reflow is not faded', report.fold.afterFold === 0, report.fold)

// 6. Teardown leaves nothing behind.
report.teardown = await evaluate(`(() => {
  window.__applied.dispose()
  return {
    bodyAttr: document.body.hasAttribute('data-dsh-stream-motion'),
    styleId: document.getElementById('dsh-stream-motion-style') !== null,
    highlights: CSS.highlights.size,
  }
})()`)
check('teardown removes the gate attribute', report.teardown.bodyAttr === false, report.teardown.bodyAttr)
check('teardown removes the sheet', report.teardown.styleId === false, report.teardown.styleId)
check('teardown releases every highlight', report.teardown.highlights === 0, report.teardown.highlights)

const failed = report.checks.filter(entry => !entry.passed)
console.log(JSON.stringify(report, null, 2))
console.log(`\n${report.checks.length - failed.length}/${report.checks.length} checks passed`)

socket.close()
chrome.kill()
server.close()
process.exit(failed.length === 0 ? 0 : 1)
