#!/usr/bin/env python3
"""Exercise a local OA API using a configured test model; sends one or two requests."""
import argparse
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--base-url", default="http://127.0.0.1:8787/v1")
parser.add_argument("--token-file", type=Path, required=True)
parser.add_argument("--model", default="oa-e2e-streaming")
parser.add_argument("--stream-only", action="store_true", help="Send only the streaming request (useful for one-use zkAPI leases).")
args = parser.parse_args()
token = args.token_file.read_text().strip()
base = args.base_url.rstrip("/")
headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
payload = {
    "model": args.model,
    "messages": [{"role": "system", "content": "You are testing OpenAI API compatibility."},
                 {"role": "user", "content": "Count from one to twenty, writing each number as a word."}],
    "max_tokens": 100,
}

# A missing local token must not expose the user's catalog or spend credentials.
try:
    urllib.request.urlopen(base + "/models", timeout=10)
    raise AssertionError("unauthenticated model request succeeded")
except urllib.error.HTTPError as error:
    assert error.code == 401, f"expected HTTP 401, received {error.code}"

with urllib.request.urlopen(urllib.request.Request(base + "/models", headers=headers), timeout=60) as reply:
    models = json.load(reply)
assert any(item["id"] == args.model for item in models["data"]), "test model absent from catalog"

if not args.stream_only:
    payload["stream"] = False
    request = urllib.request.Request(base + "/chat/completions", json.dumps(payload).encode(), headers)
    with urllib.request.urlopen(request, timeout=180) as reply:
        completion = json.load(reply)
    assert completion["choices"][0]["message"]["role"] == "assistant"
    assert completion["choices"][0]["message"].get("content"), "nonstream response has no content"

payload["stream"] = True
request = urllib.request.Request(base + "/chat/completions", json.dumps(payload).encode(), headers)
started = time.monotonic()
first_content = None
content_events = 0
done = False
with urllib.request.urlopen(request, timeout=180) as reply:
    stream_status = reply.status
    assert stream_status == 200
    assert "text/event-stream" in reply.headers.get("Content-Type", "")
    for line in reply:
        if not line.startswith(b"data:"):
            continue
        data = line[5:].strip()
        if data == b"[DONE]":
            done = True
            break
        event = json.loads(data)
        if any(choice.get("delta", {}).get("content") for choice in event.get("choices", [])):
            content_events += 1
            if first_content is None:
                first_content = time.monotonic() - started
elapsed = time.monotonic() - started
assert done, "stream ended without [DONE]"
assert content_events > 1, "need multiple content chunks to verify incremental streaming"
assert first_content is not None and first_content < elapsed, "no content before stream completion"
print(json.dumps({
    "model": args.model,
    "catalog": "pass", "authentication": "pass", "nonstream": "not_run" if args.stream_only else "pass", "stream": "pass",
    "stream_http_status": stream_status,
    "done_marker_received": done,
    "content_events": content_events,
    "first_content_seconds": round(first_content, 3),
    "completion_seconds": round(elapsed, 3),
}, indent=2))
