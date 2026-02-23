import { Config, Effect } from "effect"
import { NotifyError } from "./errors.js"

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
        const body = JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: false,
        })
        const opts = { method: "POST", headers: { "Content-Type": "application/json" }, body }
        const url = `https://api.telegram.org/bot${token}/sendMessage`

        let r = await fetch(url, opts)
        if (r.status === 429) {
          const json = (await r.json()) as { parameters?: { retry_after?: number } }
          const wait = (json.parameters?.retry_after ?? 1) * 1000 + 200
          await new Promise((res) => setTimeout(res, wait))
          r = await fetch(url, opts)
        }
        if (!r.ok) throw new Error(`Telegram API error: ${r.status}`)
        return r.json()
      },
      catch: (cause) => new NotifyError({ cause }),
    })
  })
