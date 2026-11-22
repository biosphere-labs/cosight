#!/usr/bin/env bash
# Brings up the cosight canvas on a WSL/Linux host: working dir, static
# server, detached so it outlives this script and this Claude session.
#
# Idempotent: if the server already answers at the URL, this changes nothing
# and prints "already up". The caller decides whether to open a browser.
#
# Usage: start-canvas.sh <workdir> <port> [host]
# host defaults to 127.0.0.1; a Tailscale address lets another machine open the page.
set -euo pipefail

WORKDIR="${1:?workdir required}"
PORT="${2:-8099}"
HOST="${3:-127.0.0.1}"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://${HOST}:${PORT}/"

# files/ holds each file a stop shows, whole; audio/ the server's spoken mp3s.
mkdir -p "$WORKDIR/files" "$WORKDIR/audio"

# A tour document must exist before the page first asks, or the page has
# nothing to say about where Claude is.
DOC="$WORKDIR/tour.json"
if [ ! -f "$DOC" ]; then
  printf '{"v":0,"tourId":"","lens":"general","phase":"idle","status":"","mute":{"v":0,"on":false},"question":"","plan":[],"stops":[],"asides":[]}' > "$DOC"
fi

up() { curl -fsS -m 2 -o /dev/null "$URL"; }

# The API version the page needs (tour-server.js's API). 2 added POST /export
# for Export mode, Oct 14, 2026; 3 added the svg/ diagram cache, Oct 18, 2026.
API_NEEDED=18

if up; then
  # An older server lacks an endpoint the page calls: one from before the
  # tour.json redesign (Oct 13, 2026) has no /tour, one from before Edit mode no
  # /export. The page cannot work fully against it, so it is replaced, not kept.
  API="$(curl -fsS -m 2 "${URL}whoami" | sed -n 's/.*"api":\([0-9]*\).*/\1/p')"
  if [ "${API:-0}" -ge "$API_NEEDED" ]; then
    echo "already up: $URL"
    exit 0
  fi
  OLD_PID="$(curl -fsS -m 2 "${URL}whoami" | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')"
  if [ -n "$OLD_PID" ]; then
    kill "$OLD_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do up || break; sleep 0.25; done
  fi
  if up; then
    echo "an old server holds $URL and would not stop" >&2
    exit 1
  fi
fi

# Detached: nohup drops SIGHUP when this script's shell exits, disown removes
# it from this shell's job table, and the redirects close its inherited fds
# so the parent `bash start-canvas.sh` can exit without taking the server down.
nohup node "$SELF/tour-server.js" "$WORKDIR" "$PORT" "$HOST" >/dev/null 2>&1 < /dev/null &
disown

ok=0
for _ in $(seq 1 20); do
  sleep 0.25
  if up; then ok=1; break; fi
done
if [ "$ok" -ne 1 ]; then
  echo "server did not answer on $URL" >&2
  exit 1
fi
echo "started: $URL"
echo "workdir: $WORKDIR"
