#!/usr/bin/env bash
# Single-container runner — plain `docker run`, no compose.
#   ./run.sh            start the app (uses existing image)
#   ./run.sh --build    rebuild the image first, then start
#   ./run.sh stop       stop + remove the container
#
# Host port: APP_PORT env (default 8787). The container always listens on 8787.
set -euo pipefail

IMAGE=claude-ai-skills-report
NAME=claude-ai-skills-report
PORT="${APP_PORT:-8787}"
ROOT="$(cd "$(dirname "$0")" && pwd)"

if [ "${1:-}" = "stop" ]; then
  docker rm -f "$NAME" >/dev/null 2>&1 && echo "stopped." || echo "not running."
  exit 0
fi

if [ "${1:-}" = "--build" ]; then
  echo "Building image $IMAGE…"
  docker build -t "$IMAGE" -f "$ROOT/app/Dockerfile" "$ROOT"
elif ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Image '$IMAGE' not found — run: ./run.sh --build" >&2
  exit 1
fi

mkdir -p "$ROOT/app/db"
docker rm -f "$NAME" >/dev/null 2>&1 || true

# 8787 is often occupied on this host — find a free port starting at $PORT
is_free() { ! ss -ltn 2>/dev/null | grep -q "[:.]$1 "; }
start="$PORT"; n=0
while ! is_free "$PORT"; do
  PORT=$((PORT + 1)); n=$((n + 1))
  [ "$n" -ge 20 ] && { echo "No free host port found near $start." >&2; exit 1; }
done
[ "$PORT" != "$start" ] && echo "Host port $start busy -> using $PORT."

# Run as the host user so files written into bind-mounts (./app/db, and the
# OAuth-token cache under ~/.claude) stay owned by the host, not root.
# node:24-slim has no passwd entry for arbitrary UIDs, so $HOME inside the
# container would default to "/" — set HOME=/home/app and mount ~/.claude at
# /home/app/.claude where the Agent SDK looks for it.
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"

# .env is gitignored — load it if present, otherwise the LLM client
# will refuse to boot inside the container with a clear error.
ENV_ARGS=()
if [ -f "$ROOT/.env" ]; then ENV_ARGS+=(--env-file "$ROOT/.env"); fi

docker run -d --name "$NAME" \
  "${ENV_ARGS[@]}" \
  --user "${HOST_UID}:${HOST_GID}" \
  -p "127.0.0.1:${PORT}:8787" \
  -e PORT=8787 -e DATA_DIR=/data -e DB_DIR=/db -e HOME=/home/app \
  -v "$ROOT/data:/data:ro" \
  -v "$ROOT/app/db:/db" \
  -v "$HOME/.claude:/home/app/.claude" \
  "$IMAGE" >/dev/null

echo "App:  http://localhost:${PORT}"
echo "Logs: docker logs -f $NAME   |   Stop: ./run.sh stop"
