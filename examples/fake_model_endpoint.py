"""Fake OpenAI-compatible chat completions endpoint for the SuperAgent round-3 integration.

Why this way: harness dsh-llm-deepseek's config accepts a baseURL and calls the standard
/v1/chat/completions endpoint (schema inspected in the plugin bundle). We return a minimal
compatible response shape and record every incoming request body to a file, so we can prove
that a real HTTP round-trip happened instead of a mocked function call.

Run:  python fake_model_endpoint.py [--port 8787] [--reply 'fixed text reply']
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"
DEFAULT_PORT = 8787
REPLAY_PATH = Path(__file__).resolve().parent / "requests.jsonl"


def fake_reply(content_template: str, request_body: dict) -> str:
    """Produce a reply that embeds the original user text so we can assert downstream."""
    user_text = ""
    try:
        for msg in request_body.get("messages", []):
            if msg.get("role") == "user":
                user_text = str(msg.get("content", "")).strip()
                break
    except Exception:
        pass
    return content_template.format(user_text=user_text)


def build_response(request_body: dict, reply_text: str) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "id": "chatcmpl-fake-000000000000000000",
        "object": "chat.completion",
        "created": int(datetime.now().timestamp()),
        "model": request_body.get("model", "deepseek-v4-flash"),
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": reply_text},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


class Handler(BaseHTTPRequestHandler):
    # Suppress access-log noise on stderr; we log to the replay file instead.
    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return

    def do_POST(self) -> None:  # noqa: N802 (stdlib API naming)
        path = self.path.split("?", 1)[0]
        if path != "/v1/chat/completions":
            self._send_json(404, {"error": {"message": f"not found: {path}", "type": "invalid_request_error"}})
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        try:
            body = json.loads(raw) if raw else {}
        except json.JSONDecodeError as exc:
            self._send_json(400, {"error": {"message": f"invalid JSON: {exc}", "type": "invalid_request_error"}})
            return
        # Record the full request to a replay log so we can prove an HTTP round-trip happened.
        record = {
            "at": datetime.now(timezone.utc).isoformat(),
            "method": "POST",
            "path": path,
            "authorization": self.headers.get("Authorization", ""),
            "body": body,
        }
        with REPLAY_PATH.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        reply_text = fake_reply(self.server.reply_template, body)
        self._send_json(200, build_response(body, reply_text))

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._send_json(200, {"ok": True, "ts": datetime.now(timezone.utc).isoformat()})
            return
        self._send_json(404, {"error": {"message": f"not found: {self.path}", "type": "invalid_request_error"}})

    def _send_json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> int:
    parser = argparse.ArgumentParser(description="Fake OpenAI-compatible chat completions endpoint.")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--reply", default="echo: {user_text}",
                        help="Reply template, use {user_text} as placeholder.")
    args = parser.parse_args()
    server = ThreadingHTTPServer((HOST, args.port), Handler)
    server.reply_template = args.reply  # type: ignore[attr-defined]
    REPLAY_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Clear any prior replay so each run is a clean log.
    if REPLAY_PATH.exists():
        REPLAY_PATH.unlink()
    print(f"[fake-llm] listening on http://{HOST}:{args.port}/v1/chat/completions")
    print(f"[fake-llm] replay log -> {REPLAY_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[fake-llm] shutting down.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
