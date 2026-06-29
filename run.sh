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

# Load .env early so EXTRA_CA_BUNDLE_URL (and ANTHROPIC_* etc.) are
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

# Claude CLI auth lives in TWO host paths next to each other:
#   ~/.claude/             — the directory (.credentials.json, settings, mcp config)
#   ~/.claude.json         — the top-level config file
# The CLI checks both. Mount each individually so LLM_PROVIDER=cli works.
# ~/.claude.json is mounted as a file (not a dir), so we touch it on the
# host first to make sure the bind has something to bind to.
[ -e "$HOME/.claude.json" ] || touch "$HOME/.claude.json"

# If the host has set ANTHROPIC_BASE_URL (e.g. pointing at a local Claude
# Code router, an SSH tunnel, or a corporate gateway), forward that into
# the container with a host.docker.internal hop so `claude` CLI inside
# the container can reach a service running on the host.
#
# This is generic: we pass through whatever env you set, we do NOT hard-
# code any specific router product or URL. Set ANTHROPIC_BASE_URL +
# (optionally) ANTHROPIC_AUTH_TOKEN in your shell or .env if you need it.
CLI_ARGS=()
if [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
  CLI_ARGS+=(--add-host=host.docker.internal:host-gateway)
  CLI_ARGS+=(-e "ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL}")
fi
[ -n "${ANTHROPIC_AUTH_TOKEN:-}" ] && CLI_ARGS+=(-e "ANTHROPIC_AUTH_TOKEN=${ANTHROPIC_AUTH_TOKEN}")
[ -n "${ANTHROPIC_API_KEY:-}" ]    && CLI_ARGS+=(-e "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}")

docker run -d --name "$NAME" \
  "${ENV_ARGS[@]}" \
  "${CLI_ARGS[@]}" \
  --user "${HOST_UID}:${HOST_GID}" \
  -p "127.0.0.1:${PORT}:8787" \
  -e PORT=8787 -e DATA_DIR=/data -e DB_DIR=/db -e HOME=/home/app \
  -v "$ROOT/data:/data:ro" \
  -v "$ROOT/app/db:/db" \
  -v "$HOME/.claude:/home/app/.claude" \
  -v "$HOME/.claude.json:/home/app/.claude.json" \
  "$IMAGE" >/dev/null

echo "App:  http://localhost:${PORT}"
echo "Logs: docker logs -f $NAME   |   Stop: ./run.sh stop"
