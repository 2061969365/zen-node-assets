#!/usr/bin/env bash
# Run one template, warm it up, then measure its whole process tree.
# Usage: scripts/measure_one.sh <template> <base-port>
set -euo pipefail

tpl="${1:?template}"
base="${2:?base port}"

export PORT="$base"
export ZEN_PORT="$((base + 1))"
export EGRESS_PORT="$((base + 2))"
export NODE_TOKEN=test
export EGRESS_MODE=auto
export ALLOW_DIRECT_FALLBACK=0
export LOG_DIR=".zen-mem-$tpl"
# Keep the measurement stable: no 429 rotate churn during the sample window.
export BOOT_PROBE_TRIES=0
export PROBE_INTERVAL_SEC=3600

rm -rf "$LOG_DIR"
mkdir -p /tmp/mem

node "$tpl/index.js" > "/tmp/mem/$tpl.node.log" 2>&1 &
pid=$!
echo "$pid" > "/tmp/mem/$tpl.pid"

cleanup() {
  pkill -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
  sleep 1
  pkill -9 -P "$pid" 2>/dev/null || true
  kill -9 "$pid" 2>/dev/null || true
}
trap cleanup EXIT

status() {
  curl -s -o "/tmp/mem/$tpl.status.json" \
    -H "Authorization: Bearer test" \
    "http://127.0.0.1:$PORT/_zen/node/v1/status" || true
}

state=""
errors=0
for i in $(seq 1 240); do
  status
  state=$(python3 -c 'import json,sys
try:
    print(json.load(open(sys.argv[1])).get("state", ""))
except Exception:
    print("")' "/tmp/mem/$tpl.status.json")
  [ "$state" = "running" ] && break
  if [ "$state" = "error" ]; then
    errors=$((errors + 1))
    [ "$errors" -ge 15 ] && break
  else
    errors=0
  fi
  sleep 2
done
echo "state=$state after wait"

# Same warm-up for every template: four chat calls, status codes recorded.
: > "/tmp/mem/$tpl.chat.txt"
for i in 1 2 3 4; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 \
    -H "Authorization: Bearer public" \
    -H "Content-Type: application/json" \
    -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"Reply with ok"}],"max_tokens":8}' \
    "http://127.0.0.1:$PORT/v1/chat/completions" || true)
  echo "$code" >> "/tmp/mem/$tpl.chat.txt"
done
echo "chat=$(tr '\n' ',' < "/tmp/mem/$tpl.chat.txt")"

# Idle settle, then sample.
sleep 45
python3 scripts/mem_report.py --root "$pid" --out "/tmp/mem/$tpl.mem.json" --label "$tpl"
status

cleanup
trap - EXIT
sleep 8
