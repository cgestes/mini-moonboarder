"""mitmproxy addon: remember the Moon app's auth headers so `npm run moon:sync` can reuse them.

The Moon app's backend requires Firebase App Check (device attestation), which a script cannot
produce. Instead we borrow the session of the real app: whenever it makes an authenticated request
to its backend, we save the headers needed to replay the problem sync endpoint.

Writes, under data/:
  moon-auth.json        host + headers of the latest authenticated request (no bodies)
  moon-requests.log     one line per backend call (method, path, status, size), to follow API changes
  moon-sample-*.json    the first few responses of problem endpoints, to check their shape

Run via `npm run moon:proxy`, which only intercepts the Moon backend and tunnels everything else untouched.
"""
import json
import os
import pathlib
import time

DATA = pathlib.Path(__file__).resolve().parent.parent / "data"
HOST_SUFFIXES = ("ems-x.com", "moonclimbing.com")
KEEP = ("authorization", "transfer-bid", "transfer-purpose", "transfer-ver",
        "transfer-osver", "user-agent")
MAX_SAMPLES = 5


def _is_backend(flow):
    return flow.request.pretty_host.endswith(HOST_SUFFIXES)


def _write_private(path, text):
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text)
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def request(flow):
    if not _is_backend(flow):
        return
    headers = {k.lower(): v for k, v in flow.request.headers.items()}
    if "authorization" not in headers:
        return
    _write_private(DATA / "moon-auth.json", json.dumps({
        "host": flow.request.pretty_host,
        "captured_at": int(time.time() * 1000),
        "headers": {k: headers[k] for k in KEEP if k in headers},
    }, indent=2))
    print(f"[moon] captured auth from {flow.request.method} {flow.request.pretty_host}{flow.request.path.split('?')[0]}", flush=True)


def response(flow):
    if not _is_backend(flow):
        return
    path = flow.request.path.split("?")[0]
    size = len(flow.response.raw_content or b"")
    line = f"{time.strftime('%H:%M:%S')} {flow.request.method} {flow.request.pretty_host}{path} -> {flow.response.status_code} ({size} bytes)"
    DATA.mkdir(parents=True, exist_ok=True)
    with (DATA / "moon-requests.log").open("a") as f:
        f.write(line + "\n")
    print(f"[moon] {line}", flush=True)

    samples = sorted(DATA.glob("moon-sample-*.json"))
    if "problem" in path.lower() and len(samples) < MAX_SAMPLES:
        _write_private(DATA / f"moon-sample-{len(samples) + 1}.json", json.dumps({
            "url": flow.request.pretty_url,
            "status": flow.response.status_code,
            "body": flow.response.get_text(strict=False),
        }))
