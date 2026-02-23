import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

const STATE_PATH = join(process.cwd(), "state.json")
const BOT_UPDATE_KEY = "__bot_last_update_id__"
const MONITOR_WORKFLOWS = [
  { file: "monitor-instocktrades.yml", label: "InStockTrades" },
  { file: "monitor-ebay.yml", label: "eBay" },
] as const

type StateMap = Record<string, string>

type TelegramUpdate = {
  update_id: number
  message?: { chat: { id: number }; text?: string }
}

type WorkflowRun = {
  html_url: string
  event: string
  status: string
  conclusion: string | null
  created_at: string
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

function githubHeaders(ghToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${ghToken}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "price-monitor-bot",
  }
}

function githubContext() {
  const ghToken = process.env.GITHUB_TOKEN ?? ""
  const repo = process.env.GITHUB_REPOSITORY ?? ""
  const ref = process.env.GITHUB_REF_NAME ?? "main"

  if (!ghToken || !repo) {
    throw new Error("GitHub dispatch credentials not available")
  }

  return { ghToken, repo, ref }
}

async function dispatchWorkflow(workflowFile: string) {
  const { ghToken, repo, ref } = githubContext()

  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: "POST",
      headers: githubHeaders(ghToken),
      body: JSON.stringify({ ref }),
    },
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Dispatch failed for ${workflowFile}: ${res.status} ${body}`)
  }
}

async function getLatestWorkflowRun(workflowFile: string): Promise<WorkflowRun | null> {
  const { ghToken, repo } = githubContext()

  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/runs?per_page=1`,
    { headers: githubHeaders(ghToken) },
  )

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Status lookup failed for ${workflowFile}: ${res.status} ${body}`)
  }

  const data = (await res.json()) as { workflow_runs?: WorkflowRun[] }
  return data.workflow_runs?.[0] ?? null
}

function formatRunStatus(run: WorkflowRun | null): string {
  if (!run) return "no runs yet"
  const state = run.conclusion ?? run.status
  const time = new Date(run.created_at).toUTCString()
  return `${state} (${run.event}, ${time})`
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
      await sendMessage(token, chatId, "⚡ Triggering monitor workflows...")
      try {
        for (const workflow of MONITOR_WORKFLOWS) {
          await dispatchWorkflow(workflow.file)
        }
        await sendMessage(token, chatId, "✅ Monitor workflows dispatched.")
      } catch (error) {
        console.error(error)
        await sendMessage(token, chatId, "❌ Failed to trigger monitor workflows.")
      }
    } else if (text === "/status") {
      try {
        const statuses = await Promise.all(
          MONITOR_WORKFLOWS.map(async (workflow) => ({
            label: workflow.label,
            run: await getLatestWorkflowRun(workflow.file),
          })),
        )

        const lines = statuses.map(
          ({ label, run }) => `• <b>${label}</b>: ${formatRunStatus(run)}`,
        )
        await sendMessage(token, chatId, ["📊 Monitor status", ...lines].join("\n"))
      } catch (error) {
        console.error(error)
        await sendMessage(token, chatId, "❌ Failed to fetch workflow status.")
      }
    }
  }

  const freshState = loadState()
  freshState[BOT_UPDATE_KEY] = String(newLastId)
  saveState(freshState)
}

main().catch(console.error)
