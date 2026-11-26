/**
 * The shared mutation and size observation the follow needs, in the shape the
 * original engine gave it but without the parts a standalone plugin cannot use
 * (the skin's quiet-write filter, the deferred slices for whole-session mounts,
 * and the cross-subscription batch bookkeeping).
 */

const subscriptions = []
let observer = null
let deferred = []
let timer = null

/** Weight records plus bounded direct-child counts; a large batch defers without a deep subtree scan. */
const SYNC_BATCH_WEIGHT = 100
const DISPATCH_BUDGET_MS = 8

function pageWide(target) {
  return target === document || target === document.documentElement || target === document.body
}

function selects(subscription, record) {
  const options = subscription.options
  if (record.type === 'childList' && options.childList !== true) return false
  if (record.type === 'characterData' && options.characterData !== true) return false
  if (record.type === 'attributes') {
    const filter = options.attributeFilter
    if (options.attributes !== true && filter === undefined) return false
    if (filter !== undefined && !filter.includes(record.attributeName ?? '')) return false
  }
  const target = subscription.target
  if (record.target !== target) {
    if (options.subtree !== true) return false
    if (!target.contains(record.target) && !(pageWide(target) && !record.target.isConnected)) return false
  }
  return true
}

function batchWeight(records) {
  let weight = 0
  for (const record of records) {
    weight += 1
    for (const node of record.addedNodes) {
      if (node instanceof Element) weight += 1 + Math.min(node.childElementCount, 128)
    }
  }
  return weight
}

function deliver(subscription, records) {
  const selected = records.filter((record) => selects(subscription, record))
  if (selected.length === 0) return
  try {
    subscription.callback(selected)
  } catch (error) {
    reportError(error)
  }
}

function dispatchSlices() {
  timer = null
  const started = performance.now()
  while (deferred.length > 0) {
    const batch = deferred[0]
    while (batch.cursor < batch.audience.length) {
      const subscription = batch.audience[batch.cursor]
      batch.cursor += 1
      if (!subscriptions.includes(subscription)) continue
      deliver(subscription, batch.records)
      if (performance.now() - started >= DISPATCH_BUDGET_MS) {
        scheduleDispatch()
        return
      }
    }
    deferred.shift()
  }
}

function scheduleDispatch() {
  if (timer !== null || deferred.length === 0) return
  timer = setTimeout(dispatchSlices, 0)
}

function routeRecords(records) {
  const audience = subscriptions.slice()
  if (batchWeight(records) > SYNC_BATCH_WEIGHT) {
    deferred.push({ records, audience, cursor: 0 })
    scheduleDispatch()
    return
  }
  for (const subscription of audience) {
    if (!subscriptions.includes(subscription)) continue
    deliver(subscription, records)
  }
}

function refresh() {
  const pending = observer === null ? [] : observer.takeRecords()
  if (observer !== null) observer.disconnect()
  if (subscriptions.length === 0) {
    observer = null
    deferred.length = 0
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    return
  }
  if (observer === null) observer = new MutationObserver(routeRecords)
  const merged = new Map()
  for (const { target, options } of subscriptions) {
    const into = merged.get(target) ?? {}
    if (options.childList === true) into.childList = true
    if (options.characterData === true) into.characterData = true
    if (options.characterDataOldValue === true) into.characterDataOldValue = true
    if (options.subtree === true) into.subtree = true
    if (options.attributeOldValue === true) into.attributeOldValue = true
    if (options.attributes === true && options.attributeFilter === undefined) {
      into.attributes = true
      into.attributeFilter = undefined
      merged.set(target, into)
      continue
    }
    if (options.attributeFilter !== undefined && !(into.attributes === true && into.attributeFilter === undefined)) {
      into.attributeFilter = [...new Set([...(into.attributeFilter ?? []), ...options.attributeFilter])]
    }
    merged.set(target, into)
  }
  for (const [target, init] of merged) {
    if (init.attributeFilter === undefined) delete init.attributeFilter
    observer.observe(target, init)
  }
  if (pending.length > 0) {
    const audience = subscriptions.filter((subscription) => subscription !== joining)
    queueMicrotask(() => routeRecords(pending))
  }
}

let joining = null

export function subscribeMutations(target, options, callback) {
  const subscription = { target, options, callback }
  joining = subscription
  subscriptions.push(subscription)
  refresh()
  joining = null
  return () => {
    const at = subscriptions.indexOf(subscription)
    if (at === -1) return
    subscriptions.splice(at, 1)
    refresh()
  }
}

/** The elements one selector matches, kept current by the child-list records. */
export function observeMatches(selector, onChange) {
  const items = new Set(document.querySelectorAll(selector))
  let ordered = null
  const listeners = new Set()
  if (onChange !== undefined) listeners.add(onChange)
  const stop = subscribeMutations(document.body, { childList: true, subtree: true }, (records) => {
    let changed = false
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue
        if (items.delete(node)) changed = true
        for (const item of items) {
          if (node.contains(item)) {
            items.delete(item)
            changed = true
          }
        }
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        if (node.matches(selector) && !items.has(node)) {
          items.add(node)
          changed = true
        }
        for (const found of node.querySelectorAll(selector)) {
          if (!items.has(found)) {
            items.add(found)
            changed = true
          }
        }
      }
    }
    if (!changed) return
    ordered = null
    for (const listener of [...listeners]) listener()
  })
  let released = false
  return {
    all() {
      if (ordered !== null && ordered.every((item) => item.isConnected)) return ordered
      ordered = [...items].filter((item) => item.isConnected)
      items.clear()
      for (const item of ordered) items.add(item)
      return ordered
    },
    release() {
      if (released) return
      released = true
      if (onChange !== undefined) listeners.delete(onChange)
      stop()
      items.clear()
    },
  }
}

/** The attribute names a selector's matching turns on, so the marker watches those and nothing else. */
function markerAttributes(selector) {
  const names = new Set()
  for (const match of selector.matchAll(/\[\s*([\w-]+)/g)) names.add(match[1])
  if (/(^|[\s,>+~])\./.test(selector)) names.add('class')
  if (names.size === 0) {
    throw new Error(`observeMarker: "${selector}" names no attribute or class, so no arrival can be watched`)
  }
  return [...names]
}

/** The elements carrying one marker, kept current as the marker arrives and leaves. */
export function observeMarker(selector, onChange) {
  const matches = new Set(document.querySelectorAll(selector))
  const stop = subscribeMutations(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: markerAttributes(selector),
  }, (records) => {
    let changed = false
    for (const record of records) {
      if (record.type === 'attributes') {
        const target = record.target
        if (!(target instanceof Element)) continue
        if (target.matches(selector)) {
          if (!matches.has(target)) {
            matches.add(target)
            changed = true
          }
        } else if (matches.delete(target)) {
          changed = true
        }
        continue
      }
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue
        if (matches.delete(node)) changed = true
        for (const item of matches) {
          if (node.contains(item)) {
            matches.delete(item)
            changed = true
          }
        }
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        if (node.matches(selector) && !matches.has(node)) {
          matches.add(node)
          changed = true
        }
        for (const found of node.querySelectorAll(selector)) {
          if (!matches.has(found)) {
            matches.add(found)
            changed = true
          }
        }
      }
    }
    if (changed) onChange?.()
  })
  return {
    all() {
      for (const element of matches) if (!element.isConnected) matches.delete(element)
      return [...matches]
    },
    release() {
      stop()
      matches.clear()
    },
  }
}

/** One resize observer per registry, its subscriptions in the order they were made. */
function makeRegistry() {
  return { observer: null, subscriptions: [], watchers: new Map() }
}

const early = makeRegistry()
const afterHost = makeRegistry()

function makeSizeObserver(registry) {
  return new ResizeObserver((entries) => {
    for (const subscription of registry.subscriptions.slice()) {
      if (!registry.subscriptions.includes(subscription)) continue
      const own = entries.filter((entry) => subscription.lookup.has(entry.target))
      if (own.length === 0) continue
      try {
        subscription.callback(own)
      } catch (error) {
        reportError(error)
      }
    }
  })
}

/**
 * Hear the sizes of `targets`, one call per resize batch with their entries.
 * `afterHost` places this observer after every resize observer the host made
 * before the call: callbacks run in the order the observers were made, and the
 * host makes the one it pins the end from when it mounts the column. Subscribed
 * this way, the follow runs after the pin in the same frame and can put the
 * column back down before it paints.
 */
export function observeSize(targets, callback, options) {
  const registry = options?.afterHost === true ? afterHost : early
  const list = Array.isArray(targets) ? [...targets] : [targets]
  const subscription = { targets: list, lookup: new Set(list), callback }
  registry.subscriptions.push(subscription)
  for (const target of subscription.targets) {
    registry.watchers.set(target, (registry.watchers.get(target) ?? 0) + 1)
  }
  if (registry === afterHost) {
    // Made anew, so it is younger than the host's; every element is watched
    // again and reports its size once more, which a size callback takes as no
    // change.
    if (registry.observer !== null) registry.observer.disconnect()
    registry.observer = makeSizeObserver(registry)
    for (const element of registry.watchers.keys()) registry.observer.observe(element)
  } else {
    if (registry.observer === null) registry.observer = makeSizeObserver(registry)
    for (const target of subscription.targets) {
      // Watched again, so the new subscription hears the current size first.
      if (registry.watchers.get(target) > 1) registry.observer.unobserve(target)
      registry.observer.observe(target)
    }
  }
  return () => {
    const at = registry.subscriptions.indexOf(subscription)
    if (at === -1) return
    registry.subscriptions.splice(at, 1)
    for (const target of subscription.targets) {
      const count = registry.watchers.get(target) - 1
      if (count > 0) {
        registry.watchers.set(target, count)
        continue
      }
      registry.watchers.delete(target)
      if (registry.observer !== null) registry.observer.unobserve(target)
    }
    if (registry.subscriptions.length > 0) return
    if (registry.observer !== null) registry.observer.disconnect()
    registry.observer = null
  }
}
