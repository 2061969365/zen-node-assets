#!/usr/bin/env bash
# One controlled WARP run for the IPv6 isolation experiment.
# Records egress IPv4/IPv6 and the chat status codes.
# Usage: scripts/ipv6_run.sh <template> <label> <port> <force_v4:0|1>
set -uo pipefail

template="${1:?template}"
label="${2:?label}"
port="${3:?port}"
force="${4:?0|1}"

export PORT="$port"
export ZEN_PORT="$((port + 1))"
export EGRESS_PORT="$((port + 2))"
export NODE_TOKEN=test
export EGRESS_MODE=auto
export ALLOW_DIRECT_FALLBACK=0
export LOG_DIR=".zen-ipv6-$label"
export BOOT_PROBE_TRIES=0
export PROBE_INTERVAL_SEC=3600
export WARP_FORCE_IPV4="$force"

rm -rf "$LOG_DIR"
mkdir -p /tmp/mem
node "$template/index.js" > "/tmp/mem/ipv6-$label.node.log" 2>&1 &
pid=$!

cleanup() {
  pkill -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
  sleep 1
  pkill -9 -P "$pid" 2>/dev/null || true
  kill -9 "$pid" 2>/dev/null || true
}
trap cleanup EXIT

status_file="/tmp/mem/ipv6-$label.status.json"
state=""
errors=0
for i in $(seq 1 90); do
  curl -s -o "$status_file" -H "Authorization: Bearer test" \
    "http://127.0.0.1:$PORT/_zen/node/v1/status" || true
  state=$(python3 -c 'import json,sys
try:
    print(json.load(open(sys.argv[1])).get("state", ""))
except Exception:
    print("")' "$status_file")
  [ "$state" = "running" ] && break
  if [ "$state" = "error" ]; then
    errors=$((errors + 1))
    [ "$errors" -ge 10 ] && break
  else
    errors=0
  fi
  sleep 2
done

codes=""
for i in 1 2 3 4; do
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 \
    -H "Authorization: Bearer public" \
    -H "Content-Type: application/json" \
    -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"Reply with ok"}],"max_tokens":8}' \
    "http://127.0.0.1:$PORT/v1/chat/completions" || true)
  codes="${codes}${c},"
done

python3 - "$template" "$label" "$force" "$state" "$codes" "$status_file" <<'PY'
import json
import os
import sys

template, label, force, state, codes, status_file = sys.argv[1:7]
st = {}
try:
    with open(status_file, "r", encoding="utf-8") as fh:
        st = json.load(fh)
except Exception:
    pass
eg = st.get("egress") or {}
rec = {
    "template": template,
    "label": label,
    "force_v4": int(force),
    "state": state,
    "ip": eg.get("ip", ""),
    "ip6": eg.get("ip6", ""),
    "codes": [c for c in codes.split(",") if c],
}
with open("/tmp/mem/ipv6.jsonl", "a", encoding="utf-8") as fh:
    fh.write(json.dumps(rec) + "\n")
print(json.dumps(rec))
PY

cleanup
trap - EXIT
sleep 5
