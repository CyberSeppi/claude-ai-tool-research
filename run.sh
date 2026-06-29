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

# Load .env early so EXTRA_CA_BUNDLE_URL (and other build/run knobs) are
# available below — set -a / +a auto-exports all loaded vars.
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

if [ "${1:-}" = "--build" ]; then
  echo "Building image $IMAGE…"
  BUILD_ARGS=()
  if [ -n "${EXTRA_CA_BUNDLE_URL:-}" ]; then
    BUILD_ARGS+=(--build-arg "EXTRA_CA_BUNDLE_URL=${EXTRA_CA_BUNDLE_URL}")
  fi
  docker build "${BUILD_ARGS[@]}" -t "$IMAGE" -f "$ROOT/app/Dockerfile" "$ROOT"
elif ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Image '$IMAGE' not found — run: ./run.sh --build" >&2
  exit 1
fi

mkdir -p "$ROOT/app/db"
docker rm -f "$NAME" >/dev/null 2>&1 || true

# Default port 8787 is often busy on dev boxes — find a free port near it.
is_free() { ! ss -ltn 2>/dev/null | grep -q "[:.]$1 "; }
start="$PORT"; n=0
while ! is_free "$PORT"; do
  PORT=$((PORT + 1)); n=$((n + 1))
  [ "$n" -ge 20 ] && { echo "No free host port found near $start." >&2; exit 1; }
done
[ "$PORT" != "$start" ] && echo "Host port $start busy -> using $PORT."

# Run as the host user so files written into bind-mounts (./app/db) stay
# host-owned. node:24-slim has no passwd entry for arbitrary UIDs, so $HOME
# inside the container would default to "/" — point it at /home/app.
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"

# .env is gitignored — pass through if present. Without it the app will
# refuse to boot with a clear error listing the missing keys.
ENV_ARGS=()
if [ -f "$ROOT/.env" ]; then ENV_ARGS+=(--env-file "$ROOT/.env"); fi

# Always make the host reachable as `host.docker.internal` so users can
# point LLM_API_BASE_URL at a host-side proxy (e.g. claude-bridge,
# litellm, openrouter) without having to remember this flag.
NET_ARGS=(--add-host=host.docker.internal:host-gateway)

docker run -d --name "$NAME" \
  "${ENV_ARGS[@]}" \
  "${NET_ARGS[@]}" \
  --user "${HOST_UID}:${HOST_GID}" \
  -p "127.0.0.1:${PORT}:8787" \
  -e PORT=8787 -e DATA_DIR=/data -e DB_DIR=/db -e HOME=/home/app \
  -v "$ROOT/data:/data:ro" \
  -v "$ROOT/app/db:/db" \
  "$IMAGE" >/dev/null

echo "App:  http://localhost:${PORT}"
echo "Logs: docker logs -f $NAME   |   Stop: ./run.sh stop"
