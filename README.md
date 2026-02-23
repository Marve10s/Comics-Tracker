# Telegram Bot Monitoring

Open-source Telegram bot + scraper monitoring template.

It can:

- monitor pages/lists with CSS selectors (`src/monitor.ts`)
- send Telegram alerts when new items/changes are found
- accept Telegram commands (`/test`, `/trigger`, `/status`)
- trigger/check GitHub Actions workflows from a webhook bot (useful on Render)

## What you need to customize

- `monitors-ebay.json` / `monitors-instocktrades.json`: replace with your own monitor targets, selectors, filters, and URLs
- `.github/workflows/*.yml`: update schedules, timezone window, and which monitor JSON files are executed
- `render.yaml`: set your `GITHUB_REPOSITORY` and private env vars in Render

## Quick start

1. Install dependencies:
   `npm ci`
2. Copy env file:
   `cp .env.example .env`
3. Fill in at least `TELEGRAM_TOKEN` and `TELEGRAM_CHAT_ID`
4. Load env vars in your shell:
   `set -a; source .env; set +a`
5. Test a monitor locally:
   `npx tsx src/monitor.ts monitors-instocktrades.json`
6. Test the bot polling command listener:
   `npx tsx src/bot.ts`

## Docs

- Full setup + installation guide: [`INSTALLATION.md`](INSTALLATION.md)

## Available scripts

- `npm run test:run` - runs `src/monitor.ts` (expects a `monitors.json` file unless you run `npx tsx src/monitor.ts <your-file>.json`)
- `npm run bot:webhook` - starts webhook bot HTTP server
- `npm run bot:webhook:set` - registers Telegram webhook using `BOT_PUBLIC_URL`
- `npm run typecheck`
- `npm run lint`

## Commands (Telegram)

- `/test` - checks bot health
- `/trigger` - dispatches configured monitor GitHub Actions workflows
- `/status` - fetches latest run status for configured monitor workflows

## Notes

- `state.json` stores dedupe state (seen items and bot update offsets)
- If Telegram credentials are missing, monitor runs log messages instead of sending alerts
- Webhook mode requires a public HTTPS URL (Render works well for this)
