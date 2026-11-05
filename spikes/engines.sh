#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# S1: three engines on loopback. base <- rover-a <- rover-b (B peers only with A).
# Peer streams on 71xx, local API (TCP) on 72xx, tokens in .run/<name>/token.
set -euo pipefail
cd "$(dirname "$0")/.."
export OFFLINE_PROTOCOL_STORE_KEY="${OFFLINE_PROTOCOL_STORE_KEY:-$(cat .run/store.key 2>/dev/null || (mkdir -p .run && openssl rand -hex 32 | tee .run/store.key))}"
CONFIG="${CONFIG:-config/engine.json}"
start() { # name listen api [peer]
  local d=".run/$1"; mkdir -p "$d/mls" "$d/state"
  .venv/bin/offline-protocol-service --config "$CONFIG" --mls-root "$d/mls" --state-root "$d/state" \
    --tcp "$3" --token-file "$d/token" --listen "127.0.0.1:$2" ${4:+--peer "$4"} >"$d/log" 2>&1 &
  echo "$1 pid $!"
}
start base    7101 7201
start rover-a 7102 7202 127.0.0.1:7101
start rover-b 7103 7203 127.0.0.1:7102
wait
