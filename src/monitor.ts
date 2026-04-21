import { Effect, Ref } from "effect"
import { createHash } from "crypto"
import { readFileSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import {
  fetchPage,
  extractFields,
  extractItemList,
  type ScrapedItem,
  type ExtractOptions,
} from "./scraper.js"
import { sendMessage } from "./telegram.js"

interface FieldsMonitor {
  type?: "fields"
  name: string
  url: string
  selectors: Record<string, string>
}

interface ListMonitor extends ExtractOptions {
  type: "list"
  name: string
  urls: string[]
  itemSelector: string
  fields: Record<string, string>
  maxPrice?: number
  sections?: string[]
  pageParam?: string
  maxPages?: number
  snapshotFile?: string
}

type MonitorConfig = FieldsMonitor | ListMonitor

export interface MonitorResult {
  name: string
  status: "initialized" | "new_items" | "changed" | "unchanged" | "error"
  count?: number
  newItems?: ScrapedItem[]
  changes?: {
    added: number
    removed: number
    priceIncreased: number
    priceDecreased: number
  }
  error?: string
}

type StateMap = Record<string, string>

interface CatalogSnapshotItem {
  id: string
  title: string
  url: string
  price: string | null
  priceValue: number | null
  discount: string | null
}

interface CatalogSnapshot {
  monitorName: string
  capturedAt: string
  itemCount: number
  items: CatalogSnapshotItem[]
}

interface CatalogPriceChange {
  previous: CatalogSnapshotItem
  current: CatalogSnapshotItem
}

interface CatalogDiff {
  added: CatalogSnapshotItem[]
  removed: CatalogSnapshotItem[]
  priceIncreased: CatalogPriceChange[]
  priceDecreased: CatalogPriceChange[]
}

const STATE_PATH = join(process.cwd(), "state.json")
const MONITORS_PATH = join(process.cwd(), process.argv[2] ?? "monitors.json")

function loadStateFile(): StateMap {
  if (!existsSync(STATE_PATH)) return {}
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as StateMap
  } catch {
    return {}
  }
}

function saveStateFile(state: StateMap): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n")
}

function resolveMonitorFile(file: string): string {
  return join(process.cwd(), file)
}

function loadCatalogSnapshot(file: string): CatalogSnapshot | null {
  const snapshotPath = resolveMonitorFile(file)
  if (!existsSync(snapshotPath)) return null
  try {
    return JSON.parse(readFileSync(snapshotPath, "utf-8")) as CatalogSnapshot
  } catch {
    return null
  }
}

function saveCatalogSnapshot(file: string, snapshot: CatalogSnapshot): void {
  const snapshotPath = resolveMonitorFile(file)
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n")
}

function monitorKey(name: string): string {
  return createHash("sha256").update(name).digest("hex")
}

function hashData(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex")
}

function parsePrice(str: string | null | undefined): number | null {
  if (!str) return null
  const m = /\$([\d,]+(?:\.\d{2})?)/.exec(str)
  if (!m) return null
  return parseFloat(m[1].replace(/,/g, ""))
}

function esc(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function formatItemLine(item: ScrapedItem): string {
  const title = esc(item.fields["title"] ?? item.id)
  const link = item.url ? `<a href="${item.url}">${title}</a>` : `<b>${title}</b>`
  const extras: string[] = []
  const discount = item.fields["discount"]?.replace(/\s+/g, " ").trim()
  const price = item.fields["price"]?.trim()
  if (discount) extras.push(discount)
  if (price) extras.push(price)
  return `• ${link}${extras.length ? "  —  " + extras.join("  /  ") : ""}`
}

function detectSection(title: string, sections: string[]): string {
  const lower = title.toLowerCase()
  for (const section of sections) {
    if (lower.includes(section.toLowerCase())) return section
  }
  return "Others"
}

function formatNewItems(
  monitorName: string,
  items: ScrapedItem[],
  sections?: string[],
): string {
  const count = items.length
  const header = `⚡ <b>${count} new item${count > 1 ? "s" : ""}</b> — ${esc(monitorName)}`

  if (!sections || sections.length === 0) {
    return [header, "", ...items.map(formatItemLine)].join("\n")
  }

  const groups = new Map<string, ScrapedItem[]>()
  for (const item of items) {
    const section = detectSection(item.fields["title"] ?? item.id, sections)
    if (!groups.has(section)) groups.set(section, [])
    groups.get(section)!.push(item)
  }

  const ordered = [
    ...sections.filter((s) => groups.has(s)),
    ...(groups.has("Others") ? ["Others"] : []),
  ]

  const lines = [header]
  for (const section of ordered) {
    lines.push("", `<b>${esc(section)}</b>`)
    for (const item of groups.get(section)!) lines.push(formatItemLine(item))
  }
  return lines.join("\n")
}

function formatCatalogItemLink(item: CatalogSnapshotItem): string {
  const title = esc(item.title || item.id)
  return item.url ? `<a href="${item.url}">${title}</a>` : `<b>${title}</b>`
}

function formatCatalogPrice(item: CatalogSnapshotItem): string {
  if (item.price) return item.price.trim()
  if (item.priceValue !== null) return `$${item.priceValue.toFixed(2)}`
  return "price n/a"
}

function formatCatalogItemLine(item: CatalogSnapshotItem): string {
  const extras: string[] = []
  if (item.discount) extras.push(item.discount.trim())
  extras.push(formatCatalogPrice(item))
  return `• ${formatCatalogItemLink(item)}${extras.length ? "  —  " + extras.join("  /  ") : ""}`
}

function formatCatalogPriceChangeLine(change: CatalogPriceChange): string {
  return `• ${formatCatalogItemLink(change.current)}  —  ${formatCatalogPrice(change.previous)} -> ${formatCatalogPrice(change.current)}`
}

function hasCatalogChanges(diff: CatalogDiff): boolean {
  return (
    diff.added.length > 0 ||
    diff.removed.length > 0 ||
    diff.priceIncreased.length > 0 ||
    diff.priceDecreased.length > 0
  )
}

function formatCatalogChanges(monitorName: string, diff: CatalogDiff): string {
  const summary = [
    `new ${diff.added.length}`,
    `removed ${diff.removed.length}`,
    `price down ${diff.priceDecreased.length}`,
    `price up ${diff.priceIncreased.length}`,
  ].join("  /  ")

  const lines = [`📚 <b>${esc(monitorName)}</b> changed`, summary]

  if (diff.added.length > 0) {
    lines.push("", `<b>New (${diff.added.length})</b>`)
    lines.push(...diff.added.map(formatCatalogItemLine))
  }

  if (diff.removed.length > 0) {
    lines.push("", `<b>Removed (${diff.removed.length})</b>`)
    lines.push(...diff.removed.map(formatCatalogItemLine))
  }

  if (diff.priceDecreased.length > 0) {
    lines.push("", `<b>Price Down (${diff.priceDecreased.length})</b>`)
    lines.push(...diff.priceDecreased.map(formatCatalogPriceChangeLine))
  }

  if (diff.priceIncreased.length > 0) {
    lines.push("", `<b>Price Up (${diff.priceIncreased.length})</b>`)
    lines.push(...diff.priceIncreased.map(formatCatalogPriceChangeLine))
  }

  return lines.join("\n")
}

function formatErrorAlert(monitorName: string, error: unknown): string {
  const raw = String(error)
  const compact = raw.replace(/\s+/g, " ").trim()
  const summary = compact.length > 1200 ? `${compact.slice(0, 1200)}...` : compact
  return `❌ <b>Monitor failed</b> — ${esc(monitorName)}\n<code>${esc(summary)}</code>`
}

function toCatalogSnapshotItem(item: ScrapedItem): CatalogSnapshotItem {
  return {
    id: item.id,
    title: item.fields["title"]?.trim() || item.id,
    url: item.url,
    price: item.fields["price"]?.trim() ?? null,
    priceValue: parsePrice(item.fields["price"]),
    discount: item.fields["discount"]?.trim() ?? null,
  }
}

function buildCatalogSnapshot(name: string, items: ScrapedItem[]): CatalogSnapshot {
  const snapshotItems = items
    .map(toCatalogSnapshotItem)
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))

  return {
    monitorName: name,
    capturedAt: new Date().toISOString(),
    itemCount: snapshotItems.length,
    items: snapshotItems,
  }
}

function diffCatalogSnapshots(previous: CatalogSnapshot, current: CatalogSnapshot): CatalogDiff {
  const previousById = new Map(previous.items.map((item) => [item.id, item]))
  const currentById = new Map(current.items.map((item) => [item.id, item]))

  const added = current.items.filter((item) => !previousById.has(item.id))
  const removed = previous.items.filter((item) => !currentById.has(item.id))
  const priceIncreased: CatalogPriceChange[] = []
  const priceDecreased: CatalogPriceChange[] = []

  for (const currentItem of current.items) {
    const previousItem = previousById.get(currentItem.id)
    if (!previousItem) continue
    if (previousItem.priceValue === null || currentItem.priceValue === null) continue
    if (previousItem.priceValue === currentItem.priceValue) continue

    const change = { previous: previousItem, current: currentItem }
    if (currentItem.priceValue > previousItem.priceValue) {
      priceIncreased.push(change)
    } else {
      priceDecreased.push(change)
    }
  }

  return { added, removed, priceIncreased, priceDecreased }
}

const fetchMonitorItems = (monitor: ListMonitor) =>
  Effect.gen(function* () {
    const { urls, itemSelector, fields, pageParam } = monitor
    const extractOpts: ExtractOptions = {
      baseUrl: monitor.baseUrl,
      idAttribute: monitor.idAttribute,
      idPattern: monitor.idPattern,
      urlTemplate: monitor.urlTemplate,
      fieldTransforms: monitor.fieldTransforms,
    }

    const fetchItemsForUrl = (url: string) =>
      Effect.gen(function* () {
        const html = yield* fetchPage(url)
        return yield* extractItemList(html, itemSelector, fields, extractOpts)
      })

    if (!pageParam) {
      const perPage = yield* Effect.all(urls.map(fetchItemsForUrl), { concurrency: "unbounded" })
      return perPage.flat()
    }

    const maxPages = Math.max(monitor.maxPages ?? 20, 1)
    const pages: ScrapedItem[][] = []

    for (const rawUrl of urls) {
      const seedUrl = new URL(rawUrl)
      const parsedStartPage = Number(seedUrl.searchParams.get(pageParam) ?? "1")
      const startPage = Number.isFinite(parsedStartPage) && parsedStartPage > 0 ? parsedStartPage : 1

      for (let pageOffset = 0; pageOffset < maxPages; pageOffset += 1) {
        const pageNumber = startPage + pageOffset
        const pageUrl = new URL(seedUrl)
        pageUrl.searchParams.set(pageParam, String(pageNumber))

        const pageItems = yield* fetchItemsForUrl(pageUrl.toString())
        if (pageItems.length === 0) break
        pages.push(pageItems)
      }
    }

    return pages.flat()
  })

const checkCatalogSnapshotMonitor = (monitor: ListMonitor): Effect.Effect<MonitorResult, never> =>
  Effect.gen(function* () {
    const { name, snapshotFile } = monitor

    if (!snapshotFile) {
      throw new Error(`snapshotFile is required for "${name}"`)
    }

    const allItems = yield* fetchMonitorItems(monitor)
    const itemById = new Map(allItems.map((item) => [item.id, item]))

    if (itemById.size === 0) {
      yield* Effect.log(`[monitor] "${name}" returned 0 items — likely blocked/rate-limited, skipping`)
      return { name, status: "unchanged" as const }
    }

    const snapshot = buildCatalogSnapshot(name, [...itemById.values()])
    const previousSnapshot = loadCatalogSnapshot(snapshotFile)

    if (previousSnapshot === null) {
      saveCatalogSnapshot(snapshotFile, snapshot)
      yield* Effect.log(`[monitor] initialized "${name}" snapshot with ${snapshot.itemCount} items`)
      return { name, status: "initialized" as const, count: snapshot.itemCount }
    }

    const diff = diffCatalogSnapshots(previousSnapshot, snapshot)
    if (!hasCatalogChanges(diff)) {
      saveCatalogSnapshot(snapshotFile, snapshot)
      return { name, status: "unchanged" as const, count: snapshot.itemCount }
    }

    yield* sendMessage(formatCatalogChanges(name, diff))
    saveCatalogSnapshot(snapshotFile, snapshot)
    return {
      name,
      status: "changed" as const,
      count: snapshot.itemCount,
      changes: {
        added: diff.added.length,
        removed: diff.removed.length,
        priceIncreased: diff.priceIncreased.length,
        priceDecreased: diff.priceDecreased.length,
      },
    }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        yield* Effect.log(`[monitor] error on "${monitor.name}": ${error}`)
        yield* sendMessage(formatErrorAlert(monitor.name, error)).pipe(
          Effect.catchAll(() => Effect.void),
        )
        return { name: monitor.name, status: "error" as const, error: String(error) }
      }),
    ),
  )

const checkSeenItemsListMonitor = (
  monitor: ListMonitor,
  stateRef: Ref.Ref<StateMap>,
): Effect.Effect<MonitorResult, never> =>
  Effect.gen(function* () {
    const { name, maxPrice } = monitor
    const allItems = yield* fetchMonitorItems(monitor)
    const itemById = new Map(allItems.map((item) => [item.id, item]))

    if (itemById.size === 0) {
      yield* Effect.log(`[monitor] "${name}" returned 0 items — likely blocked/rate-limited, skipping`)
      return { name, status: "unchanged" as const }
    }

    const candidates = [...itemById.values()].filter((item) => {
      if (maxPrice === undefined) return true
      const price = parsePrice(item.fields["price"])
      return price !== null && price <= maxPrice
    })

    const allIds = [...itemById.keys()].sort()
    const candidateById = new Map(candidates.map((i) => [i.id, i]))
    const candidateIds = [...candidateById.keys()].sort()

    const key = monitorKey(name)
    const state = yield* Ref.get(stateRef)
    const prevRaw = state[key] ?? null

    if (prevRaw === null) {
      yield* Ref.update(stateRef, (s) => ({ ...s, [key]: JSON.stringify(allIds) }))
      yield* Effect.log(`[monitor] initialized "${name}" with ${allIds.length} items`)
      return { name, status: "initialized" as const, count: allIds.length }
    }

    const prevIds: string[] = JSON.parse(prevRaw)
    const prevSet = new Set(prevIds)

    const newItems = candidateIds
      .filter((id) => !prevSet.has(id))
      .map((id) => candidateById.get(id)!)

    yield* Ref.update(stateRef, (s) => ({ ...s, [key]: JSON.stringify(allIds) }))

    if (newItems.length === 0) {
      return { name, status: "unchanged" as const }
    }

    yield* sendMessage(formatNewItems(name, newItems, monitor.sections))
    return { name, status: "new_items" as const, newItems }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        yield* Effect.log(`[monitor] error on "${monitor.name}": ${error}`)
        yield* sendMessage(formatErrorAlert(monitor.name, error)).pipe(
          Effect.catchAll(() => Effect.void),
        )
        return { name: monitor.name, status: "error" as const, error: String(error) }
      }),
    ),
  )

const checkListMonitor = (
  monitor: ListMonitor,
  stateRef: Ref.Ref<StateMap>,
): Effect.Effect<MonitorResult, never> =>
  monitor.snapshotFile
    ? checkCatalogSnapshotMonitor(monitor)
    : checkSeenItemsListMonitor(monitor, stateRef)

const checkFieldsMonitor = (
  monitor: FieldsMonitor,
  stateRef: Ref.Ref<StateMap>,
): Effect.Effect<MonitorResult, never> =>
  Effect.gen(function* () {
    const { name, url, selectors } = monitor

    const html = yield* fetchPage(url)
    const current = yield* extractFields(html, selectors)
    const currentHash = hashData(current)
    const key = monitorKey(name)

    const state = yield* Ref.get(stateRef)
    const prevHash = state[key] ?? null

    if (prevHash === null) {
      yield* Ref.update(stateRef, (s) => ({ ...s, [key]: currentHash }))
      yield* Effect.log(`[monitor] initialized "${name}"`)
      return { name, status: "initialized" as const }
    }

    if (prevHash !== currentHash) {
      yield* Ref.update(stateRef, (s) => ({ ...s, [key]: currentHash }))
      const fieldLines = Object.entries(current)
        .map(([k, v]) => `  • ${esc(k)}: ${esc(v ?? "(not found)")}`)
        .join("\n")
      yield* sendMessage(
        `⚡ <b>Change detected:</b> ${esc(name)}\n${fieldLines}\n\n<a href="${url}">View page</a>`,
      )
      return { name, status: "new_items" as const }
    }

    return { name, status: "unchanged" as const }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        yield* Effect.log(`[monitor] error on "${monitor.name}": ${error}`)
        yield* sendMessage(formatErrorAlert(monitor.name, error)).pipe(
          Effect.catchAll(() => Effect.void),
        )
        return { name: monitor.name, status: "error" as const, error: String(error) }
      }),
    ),
  )

const checkMonitor = (
  monitor: MonitorConfig,
  stateRef: Ref.Ref<StateMap>,
): Effect.Effect<MonitorResult, never> =>
  monitor.type === "list"
    ? checkListMonitor(monitor, stateRef)
    : checkFieldsMonitor(monitor, stateRef)

export const runMonitors = (): Effect.Effect<MonitorResult[], never> =>
  Effect.gen(function* () {
    const monitors = JSON.parse(readFileSync(MONITORS_PATH, "utf-8")) as MonitorConfig[]
    const stateRef = yield* Ref.make(loadStateFile())

    yield* Effect.log(`[monitor] checking ${monitors.length} monitor(s)`)

    const results = yield* Effect.all(
      monitors.map((m) => checkMonitor(m, stateRef)),
      { concurrency: 1 },
    )

    const finalState = yield* Ref.get(stateRef)
    saveStateFile(finalState)

    return results
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed([{ name: "system", status: "error" as const, error: String(error) }]),
    ),
  )

Effect.runPromise(runMonitors()).then((results) => {
  console.log(JSON.stringify(results, null, 2))
  process.exit(results.some((r) => r.status === "error") ? 1 : 0)
})
