# zen-node-assets

Three single-file deployment entries for a Node.js host with one random public `PORT`:

- `vpngate/index.js` — VPNGate (sing-box `openvpn-client`) egress
- `warp/index.js` — Cloudflare WARP (wgcf + sing-box `wireguard`) egress
- `warp-wireproxy/index.js` — Cloudflare WARP (wgcf + `wireproxy`, lowest memory) egress

Each file is the only thing you put on the host. On first start it downloads its runtime assets from the public Release `v2026.11.27` into `./.zen/`, verifies SHA256, and starts the gateway.

## Deploy

```bash
# copy the file for your template to the host as index.js
PORT=<platform-port> \
NODE_TOKEN=<management-token> \
PUBLIC_URL=https://<your-public-host> \
node index.js
```

No root, no `package.json`, no `npm install`, no Dockerfile.

## Environment

| Name | Required | Default | Meaning |
|---|---|---|---|
| `PORT` | yes | — | platform port; also reads `SERVER_PORT` / `P_SERVER_PORT` (Pterodactyl/KataBump) |
| `NODE_TOKEN` | no | fixed default | management bearer; `NODE_TOKEN` env overrides; effective value is written to `./.zen/node-token` |
| `NODE_ID` | no | `vpngate-1` / `warp-1` / `warp-wireproxy-1` | node identity |
| `PUBLIC_URL` | no | auto-detect | public URL used in the manifest |
| `EGRESS_MODE` | no | `auto` | `auto` = VPN/WARP egress; `direct` = host egress (CI smoke) |
| `ALLOW_DIRECT_FALLBACK` | no | vpngate `1`, warp `0`, warp-wireproxy `0` | fall back to host egress if the tunnel fails |
| `ASSETS_BASE_URL` | no | Release `v2026.11.27` | override asset source |
| `ZEN_PORT` | no | `18081` | loopback port for zen-direct |
| `EGRESS_PORT` | no | `18080` | loopback port for the egress proxy (sing-box / wireproxy) |
| `MAX_RUN_SEC` | no | `0` | rotate after N seconds; 0 disables |
| `PROBE_INTERVAL_SEC` | no | `300` | egress self-check interval |
| `ROTATE_429_THRESHOLD` | no | `1` | rotate after N new upstream 429s; `0` disables |
| `ROTATE_EGRESS_FAILS` | no | `3` | rotate after N consecutive egress failures |
| `ROTATE_INTERVAL_SEC` | no | `0` | periodic rotate interval; 0 disables |
| `ROTATE_429_GRACE_SEC` | no | `90` | ignore upstream 429s during the first N seconds after gateway start |
| `BOOT_PROBE_TRIES` | no | `4` | `/v1/chat/completions` probes before reporting running; `0` disables |
| `BOOT_PROBE_TIMEOUT_SEC` | no | `90` | per boot-probe timeout |
| `PROBE_MODEL` | no | `deepseek-v4.1-flash-free` | model used for the boot probe |
| `WARP_ENDPOINT` | no | `162.159.192.1:2408` | outer WireGuard endpoint, kept IPv4 so hosts without IPv6 can connect |
| `WARP_DNS` | no | `1.1.1.1` | DNS pushed into the tunnel; DoH for `warp`, UDP resolver for `warp-wireproxy` |
| `WARP_DNS_STRATEGY` | no | `prefer_ipv6` | sing-box resolution strategy for `warp`; `prefer_ipv4` forces IPv4 egress |
| `VPNGATE_DNS` | no | `1.1.1.1` | DoH server for the vpngate tunnel |
| `LOG_DIR` | no | `./.zen` | logs and assets |
| `LOG_MAX_MB` | no | `10` | rotate `node.log` above this size |
| `LOG_KEEP` | no | `3` | rotated `node.log` files to keep |
| `LOG_CHILD_MAX_MB` | no | `LOG_MAX_MB` | truncate any other `*.log` above this size, keeping the last 256 KiB |
| `LOG_SWEEP_INTERVAL_SEC` | no | `600` | log sweep interval |
| `LOG_MAX_AGE_DAYS` | no | `7` | delete logs older than N days; `0` disables |
| `SINGBOX_GOMEMLIMIT` | no | `64MiB` | Go heap cap for sing-box (vpngate/warp) |
| `SINGBOX_GOGC` | no | `50` | sing-box GC percent |
| `WIREPROXY_GOMEMLIMIT` | no | `32MiB` | Go heap cap for wireproxy |
| `WIREPROXY_GOGC` | no | `50` | wireproxy GC percent |

vpngate additionally needs `python3` and `curl` on the host. warp and warp-wireproxy need no Python.

`NODE_TOKEN` no longer regenerates on restart: it uses `NODE_TOKEN` if set, otherwise the fixed default baked into `index.js`. The effective token is always written to `LOG_DIR/node-token`. Because the default is public in this repo, set `NODE_TOKEN` per node if the management API is reachable from untrusted networks.

`warp` and `warp-wireproxy` keep both IPv4 and IPv6 tunnel addresses plus `::/0`; the outer endpoint stays IPv4 (`WARP_ENDPOINT`) so hosts without IPv6 can still bring the tunnel up, while IPv6-only destinations work inside it. `warp` sends DNS through the tunnel as DoH (`WARP_DNS`); `warp-wireproxy` resolves through the tunnel with `WARP_DNS`. On startup the node probes `/v1/chat/completions` and only reports `running` after a 200; 429s during boot trigger an egress rotate.

## Memory

Measured on GitHub Actions `ubuntu-latest` (Node 20, amd64) from `/proc/<pid>/smaps_rollup` in a one-off run; the measurement harness is not kept in the repo. Values are PSS in MiB after 60 s idle following four `/v1/chat/completions` requests. "Tunnel" is sing-box or wireproxy.

| Template | Node PSS | Tunnel PSS | zen-direct PSS | Total PSS | Total RSS | Sum HWM |
|---|---:|---:|---:|---:|---:|---:|
| `vpngate` | 99.7 | 65.1 | 16.3 | 181.1 | 188.2 | 191.7 |
| `warp` | 86.8 | 60.9 | 16.4 | 164.1 | 171.4 | 179.6 |
| `warp-wireproxy` | 98.9 | 13.0 | 15.2 | 127.1 | 132.8 | 136.9 |

`warp-wireproxy` replaces the ~61 MB sing-box process with a ~13 MB wireproxy process, saving roughly 37 MiB PSS versus `warp` and 54 MiB versus `vpngate`. Node RSS is dominated by V8; `SINGBOX_GOMEMLIMIT` / `WIREPROXY_GOMEMLIMIT` cap the Go side.

Runs: `vpngate` and `warp-wireproxy` from [memory 45942525430](https://github.com/2061969365/zen-node-assets/actions/runs/45942525430); `warp` from [memory 45940799384](https://github.com/2061969365/zen-node-assets/actions/runs/45940799384) (WARP tunnel stayed up; on some runners UDP 2408 is blocked and the node falls back to direct).

## Endpoints

Public:

- `GET /healthz` — platform liveness (`200` while starting)
- `GET /health` — zen-direct health (`run_id`, `egress_ip`, `stats`)
- `/v1/*` — OpenAI-compatible data plane, SSE passthrough
- `GET /` — tiny status page

Management (`Authorization: Bearer $NODE_TOKEN`):

- `GET /_zen/node/v1/manifest`
- `GET /_zen/node/v1/status`
- `GET /_zen/node/v1/logs?tail=200`
- `POST /_zen/node/v1/start`
- `POST /_zen/node/v1/stop`
- `POST /_zen/node/v1/restart`
- `POST /_zen/node/v1/rotate`
- `POST /_zen/node/v1/apply`
- `POST /_zen/node/v1/update`
- `POST /_zen/node/v1/rollback`

The console can register this host as a native node using the public URL + `/health` + `/v1`; the management endpoints are for start/stop/restart/rotate/update.

## Self-update

`POST /_zen/node/v1/update` (Bearer `NODE_TOKEN`) replaces `index.js` after SHA256 and syntax checks, keeps `index.js.bak`, then restarts.

```bash
VERSION=2026.11.28.1
SHA=$(sha256sum new-index.js | awk '{print $1}')
node -e '
  const fs=require("fs");
  const content=fs.readFileSync("new-index.js").toString("base64");
  fs.writeFileSync("body.json", JSON.stringify({
    template:"warp-wireproxy", version:process.argv[1], sha256:process.argv[2],
    content, restart:true, restartMode:"exec"
  }));
' "$VERSION" "$SHA"

curl -fsS -X POST \
  -H "Authorization: Bearer $NODE_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @body.json \
  "http://127.0.0.1:$PORT/_zen/node/v1/update"
```

`restartMode`:

- `exec` — spawn the new process, then exit (no supervisor needed)
- `exit` — exit 0 and let the platform restart (Render/Railway/Koyeb/Fly/Zeabur)
- `crash` — exit 1 and let the panel restart (Pterodactyl/KataBump)
- omit to auto-detect

`restart:false` stages the file without restarting. `POST /_zen/node/v1/rollback` restores `index.js.bak`.

Console integration plan: [docs/console-native-template-push.md](docs/console-native-template-push.md).

## Auto rotate

The node polls `/health` every 15 s. A rotate is triggered by:

- upstream `stats.up429` growing by `ROTATE_429_THRESHOLD` (default 1)
- `ROTATE_EGRESS_FAILS` consecutive egress failures (checked every `PROBE_INTERVAL_SEC`)
- `MAX_RUN_SEC` reached
- `ROTATE_INTERVAL_SEC` reached (default off)

Per template:

- `vpngate` — marks the current node burned on 429/egress failure and switches to the next verified node. Burns happen one at a time; when the last verified node is burned, it immediately re-runs selection and fetches a fresh batch. Manual/interval/max-run rotates do not burn, they just cycle through the verified nodes.
- `warp` / `warp-wireproxy` — deletes the wgcf account/profile, re-registers, and rebuilds the tunnel, giving a new WARP identity/IP.

After a successful rotate the gateway restarts and the `up429` baseline resets. `POST /_zen/node/v1/apply` also accepts `ROTATE_429_THRESHOLD`, `ROTATE_EGRESS_FAILS`, `ROTATE_INTERVAL_SEC` at runtime.

## Logs

`node.log` is rotated by size (`LOG_MAX_MB`, `LOG_KEEP`). Every other log in `LOG_DIR` — `gateway.log`, `gateway.stdio.log`, `sing-box.log`, `wireproxy.log`, `command.log`, `preflight.log`, `vpngate-select.log`, `wgcf.log`, `wireproxy-configtest.log` — is swept every `LOG_SWEEP_INTERVAL_SEC`: files above `LOG_CHILD_MAX_MB` are truncated to their last 256 KiB, and files older than `LOG_MAX_AGE_DAYS` are deleted. The sweep runs at startup and is reported in `/status` under `logs`.

## Assets

Release `v2026.11.27` contains:

- `zen-direct` (linux-amd64)
- `sing-box` (v1.14.4 linux-amd64)
- `wireproxy` (v1.1.3 linux-amd64)
- `wgcf` (linux-amd64)
- `vpngate_to_singbox.py`
- `probe_and_select_vpngate.py`
- `sha256sums.txt`

## CI

`.github/workflows/test.yml` runs on `workflow_dispatch` and `push`:

- `smoke-*`: `EGRESS_MODE=direct`, required — syntax, asset checksum, health, status/auth, SSE, restart, stop/start, rotate, watchdog.
- `egress-*`: `EGRESS_MODE=auto`, non-blocking — real VPNGate/WARP/wireproxy egress report.
- `update-*`: self-update — bad SHA rejected, version bump applied, process restarted, `.bak` created, rollback restores the old version.

## Regenerate

```bash
node _build/build.js
node _build/build-wireproxy.js
```
