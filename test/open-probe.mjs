// The opening direction: the body is inserted by the host in the click's own
// commit, so the roll has to start from the height the root had while shut.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const HTTP_PORT = 43167
const CDP_PORT = 9387

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

const profile = await mkdtemp(join(tmpdir(), 'dsh-open-'))
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

  const column = document.getElementById('column')
  const root = document.createElement('div')
  root.className = 'block'
  root.setAttribute('data-chat-flow-key', 'tool-1')

  const header = document.createElement('div')
  header.setAttribute('data-disclosure-header', '')
  const row = document.createElement('div')
  row.setAttribute('data-disclosure-row', '')
  row.setAttribute('data-expandable', '')
  row.setAttribute('role', 'button')
  row.setAttribute('aria-expanded', 'false')
  row.textContent = 'Tool call'
  header.appendChild(row)
  root.appendChild(header)

  let expanded = false
  row.addEventListener('click', () => {
    expanded = !expanded
    window.__clicks = (window.__clicks || 0) + 1
    row.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    const existing = root.querySelector('.tool-body')
    if (expanded && existing === null) {
      const body = document.createElement('div')
      body.className = 'tool-body'
      body.textContent = 'tool output line that is long enough to take real height when it opens. '.repeat(6)
      root.appendChild(body)
    } else if (!expanded && existing !== null) {
      existing.remove()
    }
  })
  column.appendChild(root)

  const marker = window.__addBlock('MARKER')
  marker.id = 'marker'

  const scroll = document.getElementById('scroll')
  scroll.scrollTop = scroll.scrollHeight
  window.__root = root
  window.__row = row
  return root.getBoundingClientRect().height
})()`)
await evaluate('window.__frame()')
await sleep(150)

const opened = await evaluate(`(async () => {
  const scroll = document.getElementById('scroll')
  const marker = document.getElementById('marker')
  const root = window.__root
  const row = window.__row
  const samples = []
  let running = true
  const look = () => {
    if (!running) return
    samples.push({
      t: Math.round(performance.now()),
      top: Math.round((marker.getBoundingClientRect().top - scroll.getBoundingClientRect().top) * 100) / 100,
      rootHeight: Math.round(root.getBoundingClientRect().height * 100) / 100,
      animations: root.getAnimations().length,
    })
    requestAnimationFrame(look)
  }
  requestAnimationFrame(look)
  await window.__frame()
  const before = { top: samples.at(-1).top, rootHeight: samples.at(-1).rootHeight }
  row.click()
  await window.__frame()
  await window.__frame()
  await window.__sleep(500)
  const after = { top: samples.at(-1).top, rootHeight: samples.at(-1).rootHeight }
  running = false
  return { before, after, samples, clicks: window.__clicks || 0 }
})()`)

const samples = opened.samples
const grew = Math.round((opened.after.rootHeight - opened.before.rootHeight) * 100) / 100
const animatedFrames = samples.filter((sample) => sample.animations > 0).length
const heights = new Set(samples.map((sample) => sample.rootHeight))
// Content above the door must not move: the door grows downward, below the fold.
const drift = Math.round((opened.after.top - opened.before.top) * 100) / 100

check('the door starts shut', opened.before.rootHeight < 60, opened.before)
check('opening it grows the root by its body', grew > 40, { grew })
check('the open is animated', animatedFrames >= 6, { animatedFrames })
check('the open is rolled, not snapped', heights.size >= 5, { distinctHeights: heights.size })
check('the host still received the click exactly once', opened.clicks === 1, { clicks: opened.clicks })
check('opening keeps the content above the fold still', Math.abs(drift) < 2, { drift })

const failed = checks.filter((entry) => !entry.passed)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) {
  console.log(JSON.stringify({ failed: failed.map((entry) => entry.name) }, null, 2))
  console.log('\n--- samples ---')
  for (const s of samples.slice(0, 30)) console.log(`t=${s.t} top=${s.top} root=${s.rootHeight} anim=${s.animations}`)
}

socket.close()
chrome.kill()
server.close()
await sleep(400)
await rm(profile, { recursive: true, force: true }).catch(() => {})
process.exit(failed.length === 0 ? 0 : 1)
