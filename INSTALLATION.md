# Installation Guide

This guide covers:

- local setup
- Telegram bot token/chat ID setup
- GitHub Actions setup (scheduled monitoring)
- Render deployment (webhook bot mode)

## 1. Prerequisites

- Node.js 22+
- npm
- A Telegram account
- A GitHub repository (your fork of this project)
- A Render account (only if using webhook mode)

## 2. Clone and install

```bash
git clone <your-fork-url>
cd price-monitor
npm ci
cp .env.example .env
```

The scripts read `process.env` directly and do not auto-load `.env`.
Before local commands, export the file in your shell:

```bash
set -a; source .env; set +a
```

## 3. Configure monitors (important)

Before running anything, replace the example monitors with your own:

- `monitors-ebay.json`
- `monitors-instocktrades.json`

You can keep the file names, or create new ones and update the workflow files.

What to change in each monitor entry:

- `name`: human-readable alert title
- `urls` / `url`: page(s) to monitor
- `itemSelector` and `fields`: CSS selectors for scraping
- `maxPrice`, `sections`, `fieldTransforms`: optional filters/formatting

## 4. Telegram setup (token + chat ID)

### Get `TELEGRAM_TOKEN` (BotFather)

1. Open Telegram and search for `@BotFather`
2. Send `/newbot`
3. Follow the prompts (bot name + username)
4. Copy the bot API token and put it in `.env` as `TELEGRAM_TOKEN`

### Get `TELEGRAM_CHAT_ID`

Simplest method (private chat):

1. Start a chat with your bot and send any message (for example `/test`)
2. Open this URL in a browser (replace `<TOKEN>`):

```text
https://api.telegram.org/bot<TOKEN>/getUpdates
```

3. Find `message.chat.id` in the JSON response
4. Put that number in `.env` as `TELEGRAM_CHAT_ID`

Notes:

- If you use a group chat, the chat ID is often a negative number
- For groups, you may need to disable privacy mode in `@BotFather` (`/setprivacy`) if you want the bot to read non-command messages

## 5. Local run (quick validation)

### Test notifications from monitor script

```bash
set -a; source .env; set +a
npx tsx src/monitor.ts monitors-instocktrades.json
```

### Test polling command listener (no Render needed)

```bash
set -a; source .env; set +a
npx tsx src/bot.ts
```

Available commands:

- `/test`
- `/trigger` (requires GitHub integration config)
- `/status` (requires GitHub integration config)

## 6. GitHub Actions setup (scheduled monitoring)

This repo includes workflows in `/Users/ibrahime/Documents/Projects/price-monitor/.github/workflows`:

- `monitor-ebay.yml`
- `monitor-instocktrades.yml`
- `bot.yml` (polling command listener every 5 min)

### Required GitHub Secrets (Repository Settings -> Secrets and variables -> Actions)

- `TELEGRAM_TOKEN`
- `TELEGRAM_CHAT_ID`

The polling bot workflow (`bot.yml`) uses `${{ github.token }}` automatically for dispatching workflows in the same repo.

### Things you should edit in the workflows

- Cron schedules (`on.schedule`)
- Active-time timezone window (`Europe/Kyiv` check)
- Monitor JSON file names in the run commands
- Workflow names if you want more generic labels

## 7. Render deployment (webhook bot mode)

Webhook mode is useful if you want Telegram commands to work instantly instead of every 5 minutes.

### 7.1 Create a GitHub token for webhook commands

The webhook bot calls the GitHub API to dispatch and check workflows. Create a token with access to your repo.

Recommended (classic PAT, simple setup):

- Scope: `repo` (private repos) or public repo access for public repos

You will use this as `GITHUB_TOKEN` in Render.

### 7.2 Deploy to Render

Option A (recommended): Blueprint deploy using `render.yaml`

1. Push your customized repo to GitHub
2. In Render, create a new Blueprint and select your repo
3. Render reads `render.yaml` and creates the web service
4. Fill in the `sync: false` environment variables in the Render UI

Option B: Manual Web Service

- Runtime: Node
- Build command: `npm ci`
- Start command: `npx tsx src/bot-webhook.ts`

### 7.3 Render environment variables

Set these in Render:

- `TELEGRAM_TOKEN` (from BotFather)
- `TELEGRAM_CHAT_ID` (your chat/group ID)
- `GITHUB_TOKEN` (PAT created above)
- `GITHUB_REPOSITORY` (`owner/repo`)
- `GITHUB_REF_NAME` (`main` or your default branch)
- `BOT_PUBLIC_URL` (your Render service URL, e.g. `https://your-service.onrender.com`)
- `TELEGRAM_WEBHOOK_PATH` (default: `/telegram/webhook`)
- `TELEGRAM_WEBHOOK_SECRET` (random long string)

### 7.4 Register Telegram webhook

After the Render service is live, register the webhook once:

```bash
set -a; source .env; set +a
npm run bot:webhook:set
```

This command uses:

- `TELEGRAM_TOKEN`
- `BOT_PUBLIC_URL`
- optional `TELEGRAM_WEBHOOK_PATH`
- optional `TELEGRAM_WEBHOOK_SECRET`

You can run it locally from your machine (with `.env` values filled in), or from any environment where those vars are available.

### 7.5 Verify deployment

Open:

- `https://your-service.onrender.com/healthz`

You should get a JSON response with `ok: true`.

Then send `/test` to your Telegram bot.

## 8. Common issues

- `Telegram credentials not configured`
  - Missing `TELEGRAM_TOKEN` or `TELEGRAM_CHAT_ID`
- `/trigger` or `/status` fails
  - Missing/invalid `GITHUB_TOKEN`
  - Wrong `GITHUB_REPOSITORY`
  - Workflow file names in `src/bot.ts` / `src/bot-webhook.ts` do not match your repo
- Webhook returns unauthorized
  - `TELEGRAM_WEBHOOK_SECRET` in Telegram webhook registration does not match the server env var
- No alerts on first run
  - Expected: first run initializes `state.json` and usually does not notify (dedupe baseline)
