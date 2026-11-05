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
        # Mirror the client's request: pi-ai always asks for SSE, and a JSON body on a
        # streaming call fails with "Stream ended without finish_reason".
        is_stream = bool(body.get("stream", False))
        if is_stream:
            self._send_stream(200, body, reply_text)
        else:
            self._send_json(200, build_response(body, reply_text))

    def _send_stream(self, status: int, request_body: dict, reply_text: str) -> None:
        """OpenAI SSE format: send role chunk, content/tool chunks, finish chunk, then [DONE]."""
        model = request_body.get("model", "fake-model")
        chat_id = "chatcmpl-fake-000000000000000000"
        created = int(datetime.now().timestamp())
        tools = request_body.get("tools", [])
        # Detect eval session: if orchestrator_eval_decide tool is offered, make a tool call to finish the eval.
        decide_tool = next((t for t in tools if t.get("function", {}).get("name") == "orchestrator_eval_decide"), None)
        route_tool = next((t for t in tools if t.get("function", {}).get("name") == "orchestrator_route"), None)
        trigger_id = None
        msg_count = len(request_body.get("messages", []))
        # A session replays its whole history on every turn, so "any tool message exists" is always
        # true after the first decision and would suppress later ones. Anchor on the newest
        # candidate card instead: emit the tool call only when nothing has answered that card yet.
        last_candidate = -1
        for index, msg in enumerate(request_body.get("messages", [])):
            content = msg.get("content")
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                text = " ".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
            else:
                # Assistant messages that only carry tool_calls have content=null.
                text = ""
            if msg.get("role") == "user" and "trigger_id" in text and "candidate" in text:
                last_candidate = index
                try:
                    parsed = json.loads(text)
                    if isinstance(parsed, dict) and "trigger_id" in parsed:
                        trigger_id = parsed["trigger_id"]
                except json.JSONDecodeError:
                    pass
        messages_after_candidate = request_body.get("messages", [])[last_candidate + 1:]
        answered = any(msg.get("role") == "tool" for msg in messages_after_candidate)
        # DEBUG: print decision variables
        print(f"[FAKE-DEBUG] msgs={msg_count} decide_tool={decide_tool is not None} trigger_id={trigger_id!r} answered={answered}", file=sys.stderr, flush=True)
        # Only emit tool_call on FIRST eval round (before any tool results);
        # subsequent rounds get plain text so the Session terminates gracefully.
        should_emit_tool = (route_tool is not None or decide_tool is not None) and trigger_id is not None and not answered
        print(f"[FAKE-DEBUG] should_emit_tool={should_emit_tool}", file=sys.stderr, flush=True)
        frames: list[str] = []
        def emit(obj: dict) -> None:
            frames.append(f"data: {json.dumps(obj, ensure_ascii=False)}\n\n")
        # 1. role chunk
        emit({"id": chat_id, "object": "chat.completion.chunk", "created": created, "model": model,
              "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]})
        if should_emit_tool:
            # An explicit human request is routed, not assessed: orchestrator_route accept creates the
            # ticket and posts the acknowledgement, which is what makes a reply show up in the outbox.
            if route_tool is not None:
                name = "orchestrator_route"
                tool_args = {"decisions": [{
                    "kind": "accept",
                    "trigger_id": trigger_id,
                    "title": "Smoke-test maildrop end-to-end reply",
                    "worktree_name": "smoke-test-reply",
                    "acknowledgement": "Replying FULL_CHAIN_OK to confirm the pipeline works.",
                }]}
            else:
                name = "orchestrator_eval_decide"
                tool_args = {
                    "trigger_id": trigger_id,
                    "decision": "accept",
                    "direction": {
                        "implementation_requested": True,
                        "target_basis": "specified",
                        "requires_design_decision": False,
                        "evidence": "Smoke test auto-accepts: message asks for FULL_CHAIN_OK reply, confirming end-to-end maildrop → orchestrator → outbox pipeline."
                    },
                    "rule_assessments": [],
                    "title": "Smoke-test maildrop end-to-end reply",
                    "scope": "Verify maildrop source triggers → orchestrator eval → reply in outbox.",
                    "worktree_name": "smoke-test-reply",
                    "intent_evidence": "Smoke test: fake LLM auto-accepts every candidate for end-to-end verification.",
                    "acknowledgement": "Replying FULL_CHAIN_OK to confirm the pipeline works.",
                    "reason": "Automated smoke test; auto-accept all maildrop candidates."
                }
            args_json = json.dumps(tool_args)
            print(f"[FAKE-DEBUG] emitting {name} args={args_json[:400]}", file=sys.stderr, flush=True)
            emit({"id": chat_id, "object": "chat.completion.chunk", "created": created, "model": model,
                  "choices": [{"index": 0, "delta": {"tool_calls": [{
                      "index": 0, "id": "call_fake_001", "type": "function",
                      "function": {"name": name, "arguments": args_json}
                  }]}, "finish_reason": None}]})
            # finish_reason = "tool_calls" (not "stop")
            emit({"id": chat_id, "object": "chat.completion.chunk", "created": created, "model": model,
                  "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]})
        else:
            # plain text reply (non-eval scenarios)
            emit({"id": chat_id, "object": "chat.completion.chunk", "created": created, "model": model,
                  "choices": [{"index": 0, "delta": {"content": reply_text}, "finish_reason": None}]})
            emit({"id": chat_id, "object": "chat.completion.chunk", "created": created, "model": model,
                  "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
        frames.append("data: [DONE]\n\n")
        # An SSE body with neither Content-Length nor chunked framing makes the client abort
        # with "Connection error" (TRANSPORT). Buffering the whole payload and declaring its
        # length keeps the response self-delimiting while staying valid text/event-stream.
        payload = "".join(frames).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)
        self.wfile.flush()

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
    parser.add_argument("--reply", default="echo: {user_text} | from-fake-llm",
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
