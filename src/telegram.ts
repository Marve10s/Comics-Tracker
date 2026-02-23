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
      try: () =>
        fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: false,
          }),
        }).then((r) => {
          if (!r.ok) throw new Error(`Telegram API error: ${r.status}`)
          return r.json()
        }),
      catch: (cause) => new NotifyError({ cause }),
    })
  })
