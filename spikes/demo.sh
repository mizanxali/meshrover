#!/usr/bin/env bash
# One live run, for the demo video. Run it from Terminal.app: rover A's safety
# camera is the Mac's webcam, and only Terminal.app has camera permission.
# Starts the engines and the dashboard unless they're already up (they keep
# running after this exits, so phones stay linked between takes), then the base
# (a new episode) and both rovers. Ctrl-C once ends the episode: the rovers stop,
# and the base uploads it to 0G Storage and anchors it on Galileo.
set -uo pipefail
set -m # each job in its own process group, so Ctrl-C reaches only this script
cd "$(dirname "$0")/.."
up() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
mkdir -p .run/base

if ! up 7201; then
  echo "starting the engines (log in .run/engines.log)"
  spikes/engines.sh </dev/null >.run/engines.log 2>&1 &
  until up 7201 && up 7202 && up 7203; do sleep 0.5; done
fi
if ! up 5173; then
  echo "starting the dashboard on http://localhost:5173 (log in .run/web.log)"
  npm run -s web </dev/null >.run/web.log 2>&1 &
fi

rm -f .run/base/fleet.json # the base writes it with the new episode; the rovers read it at start
npm run -s base </dev/null &
base=$!
until [ -s .run/base/fleet.json ]; do
  kill -0 $base 2>/dev/null || exit 1 # the base refused to start; it says why
  sleep 0.5
done
npm run -s sim </dev/null &
sim=$!

# A second SIGINT would kill the base mid-upload, so only the first is passed on.
stop() {
  trap 'echo "still recording the episode: wait"' INT
  kill -INT -- -$sim -$base 2>/dev/null
}
trap stop INT
while kill -0 $base 2>/dev/null; do wait $base; done
wait $sim 2>/dev/null
