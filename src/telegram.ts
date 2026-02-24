import { Config, Effect } from "effect"
import { NotifyError } from "./errors.js"

const TELEGRAM_MAX_MESSAGE_LEN = 4096
const TELEGRAM_SAFE_CHUNK_LEN = 3800

function chunkTelegramMessage(text: string, maxLen = TELEGRAM_SAFE_CHUNK_LEN): string[] {
  if (text.length <= maxLen) return [text]

  const chunks: string[] = []
  let current = ""

  for (const line of text.split("\n")) {
    const next = current ? `${current}\n${line}` : line
    if (next.length <= maxLen) {
      current = next
      continue
    }

    if (current) {
      chunks.push(current)
      current = ""
    }

    if (line.length <= maxLen) {
      current = line
      continue
    }

    // Fallback for unusually long single lines (avoid Telegram 4096-char rejection).
    for (let i = 0; i < line.length; i += maxLen) {
      chunks.push(line.slice(i, i + maxLen))
    }
  }

  if (current) chunks.push(current)
  return chunks
}

export const sendMessage = (text: string) =>
  Effect.gen(function* () {
    const token = yield* Config.withDefault(Config.string("TELEGRAM_TOKEN"), "")
    const chatId = yield* Config.withDefault(Config.string("TELEGRAM_CHAT_ID"), "")

    if (!token || !chatId) {
      yield* Effect.log("[telegram] credentials not set — skipping notification")
      yield* Effect.log(`[telegram] message would have been:\n${text}`)
      return
    }

    yield* Effect.tryPromise({
      try: async () => {
        const url = `https://api.telegram.org/bot${token}/sendMessage`
        const parts = chunkTelegramMessage(text).flatMap((part) =>
          part.length <= TELEGRAM_MAX_MESSAGE_LEN
            ? [part]
            : chunkTelegramMessage(part, TELEGRAM_MAX_MESSAGE_LEN),
        )

        for (const part of parts) {
          const body = JSON.stringify({
            chat_id: chatId,
            text: part,
            parse_mode: "HTML",
            disable_web_page_preview: false,
          })
          const opts = { method: "POST", headers: { "Content-Type": "application/json" }, body }

          let r = await fetch(url, opts)
          if (r.status === 429) {
            const json = (await r.json()) as { parameters?: { retry_after?: number } }
            const wait = (json.parameters?.retry_after ?? 1) * 1000 + 200
            await new Promise((res) => setTimeout(res, wait))
            r = await fetch(url, opts)
          }
          if (!r.ok) {
            const errBody = await r.text()
            throw new Error(`Telegram API error: ${r.status} ${errBody}`)
          }
          await r.json()
        }
      },
      catch: (cause) => new NotifyError({ cause }),
    })
  })
