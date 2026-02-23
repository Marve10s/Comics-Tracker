"""State management via Upstash Redis REST API (no redis client needed)."""
import os
import json
import urllib.parse
import requests

UPSTASH_URL = os.environ.get("UPSTASH_REDIS_REST_URL", "")
UPSTASH_TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN", "")


def _headers():
    return {"Authorization": f"Bearer {UPSTASH_TOKEN}"}


def get(key: str) -> str | None:
    if not UPSTASH_URL:
        return None
    encoded = urllib.parse.quote(key, safe="")
    try:
        resp = requests.get(f"{UPSTASH_URL}/get/{encoded}", headers=_headers(), timeout=5)
        result = resp.json().get("result")
        return result
    except Exception as e:
        print(f"[state.get] error: {e}")
        return None


def set(key: str, value: str) -> None:
    if not UPSTASH_URL:
        return
    encoded_key = urllib.parse.quote(key, safe="")
    encoded_val = urllib.parse.quote(value, safe="")
    try:
        requests.get(
            f"{UPSTASH_URL}/set/{encoded_key}/{encoded_val}",
            headers=_headers(),
            timeout=5,
        )
    except Exception as e:
        print(f"[state.set] error: {e}")
