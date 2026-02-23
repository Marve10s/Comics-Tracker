import { Effect } from "effect"
import * as cheerio from "cheerio"
import { FetchError, ParseError } from "./errors.js"

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  Connection: "keep-alive",
  "Upgrade-Insecure-Requests": "1",
}

export const fetchPage = (url: string): Effect.Effect<string, FetchError> =>
  Effect.tryPromise({
    try: async () => {
      const resp = await fetch(url, { headers: HEADERS })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      return resp.text()
    },
    catch: (cause) => new FetchError({ url, cause }),
  })

export const extractFields = (
  html: string,
  selectors: Record<string, string>,
): Effect.Effect<Record<string, string | null>, ParseError> =>
  Effect.try({
    try: () => {
      const $ = cheerio.load(html)
      return Object.fromEntries(
        Object.entries(selectors).map(([field, selector]) => [
          field,
          $(selector).first().text().trim() || null,
        ]),
      )
    },
    catch: (cause) => new ParseError({ cause }),
  })

export interface ScrapedItem {
  id: string
  url: string
  fields: Record<string, string | null>
}

export interface ExtractOptions {
  baseUrl?: string
  idAttribute?: string
  urlTemplate?: string
  fieldTransforms?: Record<string, string>
}

export const extractItemList = (
  html: string,
  itemSelector: string,
  fieldSelectors: Record<string, string>,
  options: ExtractOptions = {},
): Effect.Effect<ScrapedItem[], ParseError> =>
  Effect.try({
    try: () => {
      const { baseUrl, idAttribute, urlTemplate, fieldTransforms } = options
      const $ = cheerio.load(html)
      const items: ScrapedItem[] = []

      $(itemSelector).each((_, el) => {
        const fields: Record<string, string | null> = {}

        for (const [field, selectorRaw] of Object.entries(fieldSelectors)) {
          const attrMatch = /^(.+)@([\w-]+)$/.exec(selectorRaw)
          if (attrMatch) {
            const [, selector, attr] = attrMatch
            const raw = $(el).find(selector).first().attr(attr) ?? null
            if (raw && baseUrl) {
              try {
                fields[field] = new URL(raw, baseUrl).toString()
              } catch {
                fields[field] = raw
              }
            } else {
              fields[field] = raw
            }
          } else {
            fields[field] = $(el).find(selectorRaw).first().text().trim() || null
          }
        }

        if (fieldTransforms) {
          for (const [field, transform] of Object.entries(fieldTransforms)) {
            const val = fields[field]
            if (!val) continue
            if (transform.startsWith("stripPrefix:")) {
              const prefix = transform.slice("stripPrefix:".length)
              fields[field] = val.startsWith(prefix) ? val.slice(prefix.length) : val
            }
          }
        }

        let id: string | null = null
        if (idAttribute) {
          id = $(el).attr(idAttribute) ?? null
        } else {
          const urlVal = fields["url"] ?? null
          const m = urlVal ? /\/products\/([^/?]+)/.exec(urlVal) : null
          id = m?.[1] ?? null
        }

        let url = ""
        if (urlTemplate && id) {
          url = urlTemplate.replace("{id}", id)
        } else {
          url = fields["url"] ?? ""
        }

        if (id) items.push({ id, url, fields })
      })

      return items
    },
    catch: (cause) => new ParseError({ cause }),
  })
