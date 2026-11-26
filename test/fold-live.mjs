// The door glide against the real host: open a real conversation, find a real
// thinking row, click its real control, and watch the height it actually rolls
// through. This is the only check that can catch a shape the harness got wrong.
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LOG = 'C:\\Users\\alzc\\AppData\\Roaming\\dsh-tauri\\logs\\desktop\\dsh-web.log'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9443

const line = readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes('?token=')).pop()
const url = line.match(/https?:\/\/\S+\?token=\S+/)[0]

const profile = mkdtempSync(join(tmpdir(), 'dsh-fold-live-'))
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1400,900', url,
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function target() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page !== undefined) return page
    } catch {}
    await sleep(500)
  }
  throw new Error('no page target')
}

const results = []
const check = (name, passed, detail) => {
  results.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}
const skip = (name, why) => {
  results.push({ name, passed: true, skipped: true, detail: why })
  console.log(`SKIP  ${name}  ${JSON.stringify(why)}`)
}

let ws
try {
  const page = await target()
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })

  let id = 0
  const waiting = new Map()
  ws.addEventListener('message', (ev) => {
    const message = JSON.parse(ev.data)
    const slot = waiting.get(message.id)
    if (slot === undefined) return
    waiting.delete(message.id)
    if (message.error) slot.reject(new Error(JSON.stringify(message.error)))
    else slot.resolve(message.result)
  })

  const evaluate = async (expression) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const reply = await new Promise((res, rej) => {
          const n = ++id
          waiting.set(n, { resolve: res, reject: rej })
          ws.send(JSON.stringify({
            id: n,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise: true, userGesture: true },
          }))
        })
        if (reply.exceptionDetails !== undefined) {
          return { __error: `${reply.exceptionDetails.text} ${reply.exceptionDetails.exception?.description ?? ''}` }
        }
        return reply.result.value
      } catch (error) {
        if (!/context|navigated/i.test(String(error.message))) throw error
        await sleep(250)
      }
    }
    throw new Error('no context')
  }

  // The token exchange navigates once, and the body does not exist for the first
  // moment after it. An evaluate that lands in that window comes back as an
  // error object, which is truthy — so the wait must compare against `true`
  // rather than test truthiness, or it stops before the bundle has run.
  for (let i = 0; i < 120; i += 1) {
    if (await evaluate('document.body !== null && document.body.hasAttribute("data-dsh-stream-motion")') === true) break
    await sleep(500)
  }
  check('the installed bundle applies in the real GUI',
    await evaluate('document.body !== null && document.body.hasAttribute("data-dsh-stream-motion")') === true)

  // The welcome page has no chat tree. The session manager lists stored
  // conversations, and each row's title is a real "open" button — that is the
  // path a reader takes, so it is the path this check takes too.
  const opened = await evaluate(`(async () => {
    const waited = (ms) => new Promise((r) => setTimeout(r, ms))
    const opener = [...document.querySelectorAll('button, [role="button"]')]
      .find((el) => (el.textContent || '').trim().startsWith('会话与工作区'))
    if (opener === undefined) return { step: 'list', ok: false }
    opener.click()
    await waited(4000)
    const rows = [...document.querySelectorAll('[data-session-id]')]
    const row = rows.find((el) => el.querySelector('.sm-rowTitleButton') !== null) ?? rows[0] ?? null
    if (row === null) return { step: 'entry', ok: false }
    const open = row.querySelector('.sm-rowTitleButton')
    if (open === null) return { step: 'button', ok: false, row: row.outerHTML.slice(0, 200) }
    const id = row.getAttribute('data-session-id')
    open.click()
    await waited(6000)
    return { step: 'done', ok: true, id, title: (open.textContent || '').trim().slice(0, 60) }
  })()`)
  check('a real conversation opens', opened?.ok === true, opened)

  await sleep(1500)
  const shape = await evaluate(`(() => ({
    flow: document.querySelectorAll('[data-chat-flow]').length,
    thinkRows: document.querySelectorAll('[data-variant="think"]').length,
    disclosureRows: document.querySelectorAll('[data-disclosure-row]').length,
    processBodies: document.querySelectorAll('[data-step-process-body]').length,
    streamBlocks: document.querySelectorAll('[data-streaming]').length,
  }))()`)
  console.log('  shape:', JSON.stringify(shape))
  if ((shape?.disclosureRows ?? 0) === 0) {
    skip('a real door rolls its height', { noDoorOnPage: shape })
    skip('the host receives the real click once', { noDoorOnPage: shape })
  } else {
    const door = await evaluate(`(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const waited = (ms) => new Promise((r) => setTimeout(r, ms))
      const control = [...document.querySelectorAll('[data-disclosure-row]')]
        .find((row) => row.getAttribute('aria-expanded') === 'true')
        ?? document.querySelector('[data-disclosure-row]')
      if (control === null) return { missing: 'no disclosure row' }
      const header = control.closest('[data-disclosure-header]')
      const root = header === null ? control.parentElement : header.parentElement
      if (root === null) return { missing: 'no root' }
      root.scrollIntoView({ block: 'center' })
      await frame()
      await waited(300)
      const before = root.getBoundingClientRect().height
      const expandedBefore = control.getAttribute('aria-expanded')
      let clicks = 0
      control.addEventListener('click', () => { clicks += 1 }, true)
      const samples = []
      let running = true
      const look = () => {
        if (!running) return
        samples.push({ h: Math.round(root.getBoundingClientRect().height * 100) / 100, a: root.getAnimations().length })
        requestAnimationFrame(look)
      }
      requestAnimationFrame(look)
      await frame()
      control.click()
      await frame()
      await frame()
      await waited(600)
      running = false
      return {
        before,
        after: Math.round(root.getBoundingClientRect().height * 100) / 100,
        expandedBefore,
        expandedAfter: control.getAttribute('aria-expanded'),
        clicks,
        animatedFrames: samples.filter((s) => s.a > 0).length,
        distinctHeights: new Set(samples.map((s) => s.h)).size,
        frames: samples.length,
      }
    })()`)
    check('a real door is found and clicked', door?.before !== undefined, door)
    check('a real door rolls its height', (door?.animatedFrames ?? 0) >= 4 && (door?.distinctHeights ?? 0) >= 4, door)
    check('the host receives the real click once', door?.clicks === 1, { clicks: door?.clicks })
    check('the real door ends in the other state', door?.expandedBefore !== door?.expandedAfter, {
      before: door?.expandedBefore, after: door?.expandedAfter,
    })

    // Closing is the direction the reader complained about: the host unmounts the
    // body in the click's own commit, so without an interception the text below
    // moves by the body's height in one frame.
    const shut = await evaluate(`(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const waited = (ms) => new Promise((r) => setTimeout(r, ms))
      const control = [...document.querySelectorAll('[data-disclosure-row]')]
        .find((row) => row.getAttribute('aria-expanded') === 'true')
      if (control === undefined) return { missing: 'no open door' }
      const header = control.closest('[data-disclosure-header]')
      const root = header === null ? control.parentElement : header.parentElement
      root.scrollIntoView({ block: 'center' })
      await frame()
      await waited(400)
      const before = Math.round(root.getBoundingClientRect().height * 100) / 100
      let clicks = 0
      control.addEventListener('click', () => { clicks += 1 }, true)
      const samples = []
      let running = true
      const look = () => {
        if (!running) return
        samples.push({ h: Math.round(root.getBoundingClientRect().height * 100) / 100, a: root.getAnimations().length })
        requestAnimationFrame(look)
      }
      requestAnimationFrame(look)
      await frame()
      control.click()
      await frame()
      await frame()
      await waited(700)
      running = false
      return {
        before,
        after: Math.round(root.getBoundingClientRect().height * 100) / 100,
        expandedAfter: control.getAttribute('aria-expanded'),
        clicks,
        animatedFrames: samples.filter((s) => s.a > 0).length,
        distinctHeights: new Set(samples.map((s) => s.h)).size,
        frames: samples.length,
      }
    })()`)
    check('a real door shuts back to its header', (shut?.after ?? 999) < (shut?.before ?? 0) && shut?.expandedAfter === 'false', shut)
    check('closing a real door is rolled, not snapped', (shut?.animatedFrames ?? 0) >= 4 && (shut?.distinctHeights ?? 0) >= 4, shut)
    check('the host receives the closing click once', shut?.clicks === 1, { clicks: shut?.clicks })

    // A tool group is a different door: it folds by setting `hidden` on a body
    // that stays mounted, and its control names the body through `aria-controls`.
    // A group in expanded mode has no cap at all, so there is nothing to roll and
    // the plugin must leave it to the host — that is asserted, not skipped.
    const group = await evaluate(`(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const waited = (ms) => new Promise((r) => setTimeout(r, ms))
      const roots = [...document.querySelectorAll('[data-step-process]')]
        .filter((root) => !root.hasAttribute('hidden') && root.getBoundingClientRect().height > 0)
      const root = roots[0]
      if (root === undefined) return { missing: 'no visible group' }
      const body = root.querySelector('[data-step-process-body]')
      const control = body !== null && body.id ? document.querySelector('[aria-controls="' + body.id + '"]') : null
      if (control === null) return { missing: 'no control', bodyId: body === null ? null : body.id }
      const capped = !root.hasAttribute('data-group-expanded-mode')
      root.scrollIntoView({ block: 'center' })
      await frame()
      await waited(400)
      const before = Math.round(root.getBoundingClientRect().height * 100) / 100
      const expandedBefore = control.getAttribute('aria-expanded')
      let clicks = 0
      control.addEventListener('click', () => { clicks += 1 }, true)
      const samples = []
      let running = true
      const look = () => {
        if (!running) return
        samples.push({ h: Math.round(root.getBoundingClientRect().height * 100) / 100, a: root.getAnimations().length })
        requestAnimationFrame(look)
      }
      requestAnimationFrame(look)
      await frame()
      control.click()
      await frame()
      await frame()
      await waited(700)
      running = false
      return {
        capped,
        before,
        after: Math.round(root.getBoundingClientRect().height * 100) / 100,
        expandedBefore,
        expandedAfter: control.getAttribute('aria-expanded'),
        bodyHidden: body.hasAttribute('hidden'),
        clicks,
        animatedFrames: samples.filter((s) => s.a > 0).length,
        distinctHeights: new Set(samples.map((s) => s.h)).size,
      }
    })()`)
    check('a real tool group is found by its aria-controls', group?.before !== undefined, group)
    check('the tool group receives its click once', group?.clicks === 1, { clicks: group?.clicks })
    if (group?.capped === true) {
      check('a capped tool group rolls rather than snapping',
        (group.animatedFrames ?? 0) >= 4 && (group.distinctHeights ?? 0) >= 4, group)
    } else {
      // An expanded group is not capped: its body never collapses, so a click only
      // changes the group's own open flag. Rolling a height that does not change
      // would be the plugin inventing motion, so the guard must leave it alone.
      check('an expanded tool group is left to the host', (group?.animatedFrames ?? 1) === 0, group)
    }
  }

  const failed = results.filter((r) => !r.passed)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed, ${results.filter((r) => r.skipped).length} skipped`)
  ws.close()
  chrome.kill()
  await sleep(400)
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch {}
  process.exit(failed.length === 0 ? 0 : 1)
} catch (error) {
  console.error('FAILED', error)
  try { ws?.close() } catch {}
  chrome.kill()
  await sleep(400)
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch {}
  process.exit(1)
}
