import { createServer } from "http"
import { getEnabledMonitorWorkflows } from "./monitor-workflows.js"

type TelegramUpdate = {
  update_id: number
  message?: { chat: { id: number }; text?: string }
}

type WorkflowRun = {
  event: string
  status: string
  conclusion: string | null
  created_at: string
}

async function sendTelegramMessage(text: string) {
  const token = process.env.TELEGRAM_TOKEN ?? ""
  const chatId = process.env.TELEGRAM_CHAT_ID ?? ""
  if (!token || !chatId) throw new Error("Telegram credentials not configured")

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  })

  if (!res.ok) {
    throw new Error(`Telegram sendMessage failed: ${res.status} ${await res.text()}`)
  }
}

function githubContext() {
  const ghToken = process.env.GITHUB_TOKEN ?? ""
  const repo = process.env.GITHUB_REPOSITORY ?? ""
  const ref = process.env.GITHUB_REF_NAME ?? "main"
  if (!ghToken || !repo) {
    throw new Error("GitHub credentials not configured (GITHUB_TOKEN/GITHUB_REPOSITORY)")
  }
  return { ghToken, repo, ref }
}

function githubHeaders(ghToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${ghToken}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "price-monitor-bot-webhook",
  }
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
    throw new Error(`Dispatch failed for ${workflowFile}: ${res.status} ${await res.text()}`)
  }
}

async function getLatestWorkflowRun(workflowFile: string): Promise<WorkflowRun | null> {
  const { ghToken, repo } = githubContext()
  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/runs?per_page=1`,
    { headers: githubHeaders(ghToken) },
  )
  if (!res.ok) {
    throw new Error(`Status lookup failed for ${workflowFile}: ${res.status} ${await res.text()}`)
  }
  const data = (await res.json()) as { workflow_runs?: WorkflowRun[] }
  return data.workflow_runs?.[0] ?? null
}

function formatRunStatus(run: WorkflowRun | null): string {
  if (!run) return "no runs yet"
  const state = run.conclusion ?? run.status
  return `${state} (${run.event}, ${new Date(run.created_at).toUTCString()})`
}

async function handleMessage(update: TelegramUpdate) {
  const expectedChatId = process.env.TELEGRAM_CHAT_ID ?? ""
  const monitorWorkflows = getEnabledMonitorWorkflows()
  const msg = update.message
  if (!msg || !expectedChatId) return
  if (String(msg.chat.id) !== expectedChatId) return

  const text = msg.text?.trim() ?? ""

  if (text === "/test") {
    await sendTelegramMessage("✅ Bot is alive and running (webhook mode).")
    return
  }

  if (text === "/trigger") {
    await sendTelegramMessage("⚡ Triggering monitor workflows...")
    try {
      for (const workflow of monitorWorkflows) {
        await dispatchWorkflow(workflow.file)
      }
      await sendTelegramMessage("✅ Monitor workflows dispatched.")
    } catch (error) {
      console.error(error)
      await sendTelegramMessage("❌ Failed to trigger monitor workflows.")
    }
    return
  }

  if (text === "/status") {
    try {
      const statuses = await Promise.all(
        monitorWorkflows.map(async (workflow) => ({
          label: workflow.label,
          run: await getLatestWorkflowRun(workflow.file),
        })),
      )
      const lines = statuses.map(
        ({ label, run }) => `• <b>${label}</b>: ${formatRunStatus(run)}`,
      )
      await sendTelegramMessage(["📊 Monitor status", ...lines].join("\n"))
    } catch (error) {
      console.error(error)
      await sendTelegramMessage("❌ Failed to fetch workflow status.")
    }
  }
}

async function readJsonBody(req: import("http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  if (chunks.length === 0) return null
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

function writeJson(
  res: import("http").ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
) {
  res.statusCode = statusCode
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(payload))
}

const port = Number(process.env.PORT ?? "3000")
const webhookPath = process.env.TELEGRAM_WEBHOOK_PATH ?? "/telegram/webhook"
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? ""

createServer(async (req, res) => {
  try {
    const url = req.url ?? "/"

    if (req.method === "GET" && (url === "/" || url === "/healthz")) {
      return writeJson(res, 200, { ok: true, mode: "webhook" })
    }

    if (req.method !== "POST" || url !== webhookPath) {
      return writeJson(res, 404, { ok: false })
    }

    if (webhookSecret) {
      const header = req.headers["x-telegram-bot-api-secret-token"]
      if (header !== webhookSecret) {
        return writeJson(res, 401, { ok: false, error: "unauthorized" })
      }
    }

    const payload = (await readJsonBody(req)) as TelegramUpdate
    writeJson(res, 200, { ok: true })
    await handleMessage(payload)
  } catch (error) {
    console.error(error)
    if (!res.headersSent) writeJson(res, 500, { ok: false, error: "server_error" })
  }
}).listen(port, () => {
  console.log(`[bot-webhook] listening on :${port} path=${webhookPath}`)
})
