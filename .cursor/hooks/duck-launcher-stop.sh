#!/bin/bash
# Cursor stop/subagentStop hook — notify Duck Launcher to build after agent completion.
input=$(cat)

python3 -c '
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

raw = sys.stdin.read()
if not raw.strip():
    sys.exit(0)

try:
    payload = json.loads(raw)
except json.JSONDecodeError:
    sys.exit(0)

event = payload.get("hook_event_name") or payload.get("hookEventName") or ""
if event not in ("stop", "subagentStop", ""):
    sys.exit(0)

status = payload.get("status") or "completed"
if status != "completed":
    sys.exit(0)

def normalize_path(path: str) -> str:
    p = (path or "").strip()
    if not p:
        return ""
    # Cursor on Windows may send /c:/Users/...
    if len(p) >= 3 and p[0] == "/" and p[2] == ":":
        p = p[1:]
    try:
        return str(Path(p).expanduser().resolve())
    except OSError:
        return str(Path(p).expanduser())

roots = payload.get("workspace_roots") or payload.get("workspaceRoots") or []
paths = []
for root in roots:
    norm = normalize_path(root)
    if norm:
        paths.append(norm)

cwd = normalize_path(payload.get("cwd") or "")
if cwd:
    paths.append(cwd)

# Preserve order, drop duplicates.
seen = set()
project_paths = []
for p in paths:
    if p not in seen:
        seen.add(p)
        project_paths.append(p)

if not project_paths:
    sys.exit(0)

home = Path.home()
config_path = home / ".duck-launcher" / "config.json"
port = int(os.environ.get("DUCK_LAUNCHER_HTTP_PORT", "0") or 0)
if port <= 0 and config_path.is_file():
    try:
        cfg = json.loads(config_path.read_text())
        port = int(cfg.get("cursor", {}).get("httpPort") or 19420)
    except (json.JSONDecodeError, TypeError, ValueError):
        port = 19420
if port <= 0:
    port = 28420

url = f"http://127.0.0.1:{port}/cursor/agent-stopped"
body = json.dumps({"projectPaths": project_paths, "status": status}).encode("utf-8")
req = urllib.request.Request(
    url,
    data=body,
    headers={"Content-Type": "application/json"},
    method="POST",
)

try:
    with urllib.request.urlopen(req, timeout=5) as resp:
        resp.read()
except (urllib.error.URLError, TimeoutError):
    pass

sys.exit(0)
' <<<"$input"

exit 0
