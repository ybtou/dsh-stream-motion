// A capped process group: the other door shape. Its body stays mounted and is
// folded by setting `hidden`, and its control names the body through
// `aria-controls`. The live page had none of these, so this is where the branch
// gets exercised.
import { createServer } from 'node:http'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const HTTP_PORT = 43169
const CDP_PORT = 9389

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

const profile = await mkdtemp(join(tmpdir(), 'dsh-group-'))
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
      if (page !== undefined) return page
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

// The capped group: `data-step-process` without `data-group-expanded-mode`, a
// header button carrying aria-expanded + aria-controls, and a body that stays in
// the document and is folded with `hidden`.
await evaluate(`(() => {
  for (let i = 0; i < 40; i += 1) window.__addBlock('history row ' + i)

  const column = document.getElementById('column')
  const group = document.createElement('div')
  group.className = 'group'
  group.setAttribute('data-chat-group-key', 'g1')
  group.setAttribute('data-chat-flow-key', 'g1')
  group.setAttribute('data-step-process', '')

  const header = document.createElement('div')
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.setAttribute('aria-expanded', 'false')
  toggle.textContent = 'Ran 3 commands'
  header.appendChild(toggle)
  group.appendChild(header)

  const body = document.createElement('div')
  body.id = 'group-body'
  body.setAttribute('data-step-process-body', '')
  body.setAttribute('data-scroll-up', '')
  body.style.cssText = 'display:block;max-height:120px;overflow:hidden'
  const content = document.createElement('div')
  content.setAttribute('data-step-process-content', '')
  content.setAttribute('data-chat-flow', '')
  content.textContent = 'tool output line that has real height and wraps a few times. '.repeat(20)
  body.appendChild(content)
  group.appendChild(body)

  toggle.setAttribute('aria-controls', body.id)
  body.setAttribute('hidden', 'until-found')
  group.style.cssText = 'display:flex;flex-direction:column'

  let open = false
  toggle.addEventListener('click', () => {
    open = !open
    window.__clicks = (window.__clicks || 0) + 1
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
    if (open) body.removeAttribute('hidden')
    else body.setAttribute('hidden', 'until-found')
  })

  column.appendChild(group)
  const marker = window.__addBlock('MARKER')
  marker.id = 'marker'
  const scroll = document.getElementById('scroll')
  scroll.scrollTop = scroll.scrollHeight
  window.__group = group
  window.__toggle = toggle
  window.__body = body
  return group.getBoundingClientRect().height
})()`)
await evaluate('window.__frame()')
await sleep(150)

const sample = async (label) => evaluate(`(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const waited = (ms) => new Promise((r) => setTimeout(r, ms))
  const group = window.__group
  const toggle = window.__toggle
  const body = window.__body
  group.scrollIntoView({ block: 'center' })
  await frame()
  await waited(200)
  const before = Math.round(group.getBoundingClientRect().height * 100) / 100
  const hiddenBefore = body.hasAttribute('hidden')
  const samples = []
  let running = true
  const look = () => {
    if (!running) return
    samples.push({ h: Math.round(group.getBoundingClientRect().height * 100) / 100, a: group.getAnimations().length })
    requestAnimationFrame(look)
  }
  requestAnimationFrame(look)
  await frame()
  toggle.click()
  await frame()
  await frame()
  await waited(700)
  running = false
  return {
    label: ${JSON.stringify(label)},
    before,
    after: Math.round(group.getBoundingClientRect().height * 100) / 100,
    hiddenBefore,
    hiddenAfter: body.hasAttribute('hidden'),
    expanded: toggle.getAttribute('aria-expanded'),
    clicks: window.__clicks || 0,
    animatedFrames: samples.filter((s) => s.a > 0).length,
    distinctHeights: new Set(samples.map((s) => s.h)).size,
    frames: samples.length,
  }
})()`)

const opened = await sample('open')
check('a capped group starts folded to its header', opened.before < 60 && opened.hiddenBefore === true, opened)
check('opening a capped group grows it', opened.after > opened.before + 40, opened)
check('opening a capped group is rolled', opened.animatedFrames >= 4 && opened.distinctHeights >= 4, opened)
check('opening it reaches the host once', opened.clicks === 1, { clicks: opened.clicks })
check('opening it clears the hidden body', opened.hiddenAfter === false && opened.expanded === 'true', opened)

const shut = await sample('close')
check('closing a capped group returns it to the header', shut.after < shut.before - 40 && shut.hiddenAfter === true, shut)
check('closing a capped group is rolled, not snapped', shut.animatedFrames >= 4 && shut.distinctHeights >= 4, shut)
check('closing it reaches the host once', shut.clicks === 2, { clicks: shut.clicks })

const failed = checks.filter((entry) => !entry.passed)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) console.log(JSON.stringify(failed.map((entry) => entry.name), null, 2))

socket.close()
chrome.kill()
server.close()
await sleep(400)
await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
process.exit(failed.length === 0 ? 0 : 1)
