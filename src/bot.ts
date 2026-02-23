import { execFileSync } from "child_process"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

const STATE_PATH = join(process.cwd(), "state.json")
const BOT_UPDATE_KEY = "__bot_last_update_id__"
const MONITOR_CONFIGS = ["monitors-instocktrades.json", "monitors-ebay.json"]

type StateMap = Record<string, string>

type TelegramUpdate = {
  update_id: number
  message?: { chat: { id: number }; text?: string }
}

function loadState(): StateMap {
  if (!existsSync(STATE_PATH)) return {}
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as StateMap
  } catch {
    return {}
  }
}

function saveState(state: StateMap): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n")
}

async function sendMessage(token: string, chatId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  })
}

async function main() {
  const token = process.env.TELEGRAM_TOKEN ?? ""
  const chatId = process.env.TELEGRAM_CHAT_ID ?? ""

  if (!token || !chatId) {
    console.log("[bot] credentials not set")
    return
  }

  const state = loadState()
  const lastId = Number(state[BOT_UPDATE_KEY] ?? "0")

  const res = await fetch(
    `https://api.telegram.org/bot${token}/getUpdates?offset=${lastId + 1}&timeout=0`,
  )
  if (!res.ok) return

  const data = (await res.json()) as { ok: boolean; result: TelegramUpdate[] }
  if (!data.ok || data.result.length === 0) return

  let newLastId = lastId
  for (const update of data.result) {
    newLastId = Math.max(newLastId, update.update_id)
    const msg = update.message
    if (!msg || String(msg.chat.id) !== chatId) continue

    const text = msg.text?.trim() ?? ""

    if (text === "/test") {
      await sendMessage(token, chatId, "✅ Bot is alive and running.")
    } else if (text === "/trigger") {
      await sendMessage(token, chatId, "⚡ Running monitors...")
      for (const config of MONITOR_CONFIGS) {
        execFileSync("npx", ["tsx", "src/monitor.ts", config], {
          stdio: "inherit",
          env: process.env,
        })
      }
      await sendMessage(token, chatId, "✅ Done.")
    }
  }

  const freshState = loadState()
  freshState[BOT_UPDATE_KEY] = String(newLastId)
  saveState(freshState)
}

main().catch(console.error)
