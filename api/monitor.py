"""
Vercel serverless function — called by cron-job.org on a schedule.
GET /api/monitor  →  checks all monitors, sends Telegram alerts on changes.
"""
import sys
import os
import json
import hashlib
from http.server import BaseHTTPRequestHandler

# Make lib importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from lib.scraper import fetch_page, extract_fields
from lib import state, telegram

MONITORS_PATH = os.path.join(os.path.dirname(__file__), "..", "monitors.json")


def load_monitors() -> list:
    with open(MONITORS_PATH) as f:
        return json.load(f)


def hash_data(data: dict) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def check_all() -> list:
    monitors = load_monitors()
    results = []

    for monitor in monitors:
        name = monitor["name"]
        url = monitor["url"]
        selectors = monitor.get("selectors", {})

        try:
            html = fetch_page(url)
            current = extract_fields(html, selectors)
            current_hash = hash_data(current)

            # Use URL hash as stable key
            state_key = f"monitor:{hash_data({'url': url})}"
            prev_hash = state.get(state_key)

            if prev_hash is None:
                # First run — initialize and notify
                state.set(state_key, current_hash)
                lines = [f"<b>Monitoring started: {name}</b>"]
                for field, val in current.items():
                    lines.append(f"  • {field}: {val or '(not found)'}")
                lines.append(f'\n<a href="{url}">View page</a>')
                telegram.send("\n".join(lines))
                results.append({"name": name, "status": "initialized", "data": current})

            elif prev_hash != current_hash:
                # Something changed
                state.set(state_key, current_hash)
                lines = [f"<b>Change detected: {name}</b>"]
                for field, val in current.items():
                    lines.append(f"  • {field}: {val or '(not found)'}")
                lines.append(f'\n<a href="{url}">View page</a>')
                telegram.send("\n".join(lines))
                results.append({"name": name, "status": "changed", "data": current})

            else:
                results.append({"name": name, "status": "unchanged"})

        except Exception as e:
            print(f"[monitor] error on {name}: {e}")
            results.append({"name": name, "status": "error", "error": str(e)})

    return results


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        results = check_all()
        body = json.dumps(results, indent=2).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.do_GET()

    def log_message(self, format, *args):
        # Suppress default HTTP server logs in Vercel
        pass
