#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${MACHIAI_REPO_URL:-https://github.com/aizakmi08/machiai.git}"
INSTALL_DIR="${MACHIAI_SOURCE_DIR:-$HOME/.machiai/source}"
DEFAULT_SERVER_URL="${MACHIAI_SERVER_URL:-https://machiai-aizakmi08.fly.dev}"
SERVER_URL="$DEFAULT_SERVER_URL"

if [[ $# -gt 0 && "$1" =~ ^https?:// ]]; then
  SERVER_URL="$1"
  shift
fi

if [[ $# -eq 0 ]]; then
  set -- sleep 300
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Machiai needs '$1' on PATH." >&2
    return 1
  fi
}

run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm "$@"
  else
    return 127
  fi
}

need git
need node

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Machiai needs Node 20 or newer. Current Node: $(node -v)" >&2
  exit 1
fi

mkdir -p "$(dirname "$INSTALL_DIR")"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Updating Machiai in $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --depth 1 origin main
  git -C "$INSTALL_DIR" checkout -q main
  git -C "$INSTALL_DIR" reset --hard -q origin/main
else
  rm -rf "$INSTALL_DIR"
  echo "Installing Machiai in $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

if run_pnpm --version >/dev/null 2>&1; then
  run_pnpm install --frozen-lockfile
  run_pnpm build
elif command -v npm >/dev/null 2>&1; then
  npm install
  npm run build
else
  echo "Machiai needs pnpm, corepack, or npm to install dependencies." >&2
  exit 1
fi

echo
echo "Machiai server: $SERVER_URL"
echo "Agent command: $*"
echo

if [[ "${MACHIAI_QUICKSTART_NO_RUN:-}" == "1" ]]; then
  echo "Machiai quickstart build completed."
  exit 0
fi

MACHIAI_SERVER_URL="$SERVER_URL" node dist/packages/cli/src/cli.js run --overlay -- "$@"
