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

// ── Config types ───────────────────────────────────────────────────────────

interface FieldsMonitor {
  type?: "fields"
  name: string
  url: string
  selectors: Record<string, string>
}

interface ListMonitor extends ExtractOptions {
  type: "list"
  name: string
  /** All pages to fetch and combine. */
  urls: string[]
  /** CSS selector matching one element per product. */
  itemSelector: string
  /** Field selectors per item. Supports `selector@attr` syntax. */
  fields: Record<string, string>
  /** Only notify for new items whose parsed price is ≤ this value. */
  maxPrice?: number
  /**
   * Section keywords checked (in order) against each item title.
   * First match wins; unmatched items go to "Others".
   * Example: ["X-Men", "Spider-Man", "Avengers"]
   */
  sections?: string[]
}

type MonitorConfig = FieldsMonitor | ListMonitor

export interface MonitorResult {
  name: string
  status: "initialized" | "new_items" | "unchanged" | "error"
  count?: number
  newItems?: ScrapedItem[]
  error?: string
}

// ── State file ─────────────────────────────────────────────────────────────

type StateMap = Record<string, string>

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

function monitorKey(name: string): string {
  return createHash("sha256").update(name).digest("hex")
}

function hashData(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex")
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Parse a price string like "$49.95" or "$1,234.56" → number */
function parsePrice(str: string | null | undefined): number | null {
  if (!str) return null
  const m = /\$([\d,]+(?:\.\d{2})?)/.exec(str)
  if (!m) return null
  return parseFloat(m[1].replace(/,/g, ""))
}

/** Escape HTML special chars in plain text used inside HTML messages. */
function esc(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Render a single item as a bullet line with a clickable title. */
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

/**
 * Detect which section an item belongs to by checking if any section keyword
 * appears in the title (case-insensitive, first match wins).
 * Falls back to "Others".
 */
function detectSection(title: string, sections: string[]): string {
  const lower = title.toLowerCase()
  for (const section of sections) {
    if (lower.includes(section.toLowerCase())) return section
  }
  return "Others"
}

/** Format a new-items notification, optionally grouped by sections. */
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

  // Group items by detected section; "Others" always goes last
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

// ── List monitor ───────────────────────────────────────────────────────────

const checkListMonitor = (
  monitor: ListMonitor,
  stateRef: Ref.Ref<StateMap>,
): Effect.Effect<MonitorResult, never> =>
  Effect.gen(function* () {
    const { name, urls, itemSelector, fields, maxPrice } = monitor
    const extractOpts: ExtractOptions = {
      baseUrl: monitor.baseUrl,
      idAttribute: monitor.idAttribute,
      urlTemplate: monitor.urlTemplate,
      fieldTransforms: monitor.fieldTransforms,
    }

    // Fetch all pages in parallel
    const pages = yield* Effect.all(urls.map(fetchPage), { concurrency: "unbounded" })

    // Extract items from each page in parallel, then combine + deduplicate by ID
    const perPage = yield* Effect.all(
      pages.map((html) => extractItemList(html, itemSelector, fields, extractOpts)),
      { concurrency: "unbounded" },
    )
    const itemById = new Map(perPage.flat().map((item) => [item.id, item]))

    // Guard: if no items were found at all, the site likely blocked us — skip silently
    if (itemById.size === 0) {
      yield* Effect.log(`[monitor] "${name}" returned 0 items — likely blocked/rate-limited, skipping`)
      return { name, status: "unchanged" as const }
    }

    // Apply price filter to determine which items are candidates for notification
    const candidates = [...itemById.values()].filter((item) => {
      if (maxPrice === undefined) return true
      const price = parsePrice(item.fields["price"])
      return price !== null && price <= maxPrice
    })

    // All IDs go into state (so above-budget items don't re-alert if price drops later).
    // Only candidates are used for new-item detection.
    const allIds = [...itemById.keys()].sort()
    const candidateById = new Map(candidates.map((i) => [i.id, i]))
    const candidateIds = [...candidateById.keys()].sort()

    const key = monitorKey(name)
    const state = yield* Ref.get(stateRef)
    const prevRaw = state[key] ?? null

    if (prevRaw === null) {
      yield* Ref.update(stateRef, (s) => ({ ...s, [key]: JSON.stringify(allIds) }))
      yield* sendMessage(
        `👀 <b>Now monitoring:</b> ${esc(name)}\nTracking <b>${allIds.length}</b> items across ${urls.length} page(s)` +
          (maxPrice !== undefined ? ` (price filter: under $${maxPrice})` : "") +
          ".",
      )
      return { name, status: "initialized" as const, count: allIds.length }
    }

    const prevIds: string[] = JSON.parse(prevRaw)
    const prevSet = new Set(prevIds)

    // New = candidate items whose ID has never appeared in state before
    const newItems = candidateIds
      .filter((id) => !prevSet.has(id))
      .map((id) => candidateById.get(id)!)

    // Always update state with the full current set
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
        return { name: monitor.name, status: "error" as const, error: String(error) }
      }),
    ),
  )

// ── Fields monitor ─────────────────────────────────────────────────────────

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
      const fieldLines = Object.entries(current)
        .map(([k, v]) => `  • ${esc(k)}: ${esc(v ?? "(not found)")}`)
        .join("\n")
      yield* sendMessage(
        `👀 <b>Now monitoring:</b> ${esc(name)}\n${fieldLines}\n\n<a href="${url}">View page</a>`,
      )
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
        return { name: monitor.name, status: "error" as const, error: String(error) }
      }),
    ),
  )

// ── Dispatch ───────────────────────────────────────────────────────────────

const checkMonitor = (
  monitor: MonitorConfig,
  stateRef: Ref.Ref<StateMap>,
): Effect.Effect<MonitorResult, never> =>
  monitor.type === "list"
    ? checkListMonitor(monitor, stateRef)
    : checkFieldsMonitor(monitor, stateRef)

// ── Main ───────────────────────────────────────────────────────────────────

export const runMonitors = (): Effect.Effect<MonitorResult[], never> =>
  Effect.gen(function* () {
    const monitors = JSON.parse(readFileSync(MONITORS_PATH, "utf-8")) as MonitorConfig[]
    const stateRef = yield* Ref.make(loadStateFile())

    yield* Effect.log(`[monitor] checking ${monitors.length} monitor(s)`)

    const results = yield* Effect.all(
      monitors.map((m) => checkMonitor(m, stateRef)),
      { concurrency: "unbounded" },
    )

    const finalState = yield* Ref.get(stateRef)
    saveStateFile(finalState)

    return results
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed([{ name: "system", status: "error" as const, error: String(error) }]),
    ),
  )

// ── Entrypoint ─────────────────────────────────────────────────────────────

Effect.runPromise(runMonitors()).then((results) => {
  console.log(JSON.stringify(results, null, 2))
  process.exit(results.some((r) => r.status === "error") ? 1 : 0)
})
