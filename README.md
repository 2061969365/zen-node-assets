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
| `PORT` | yes | — | platform-provided public port |
| `NODE_TOKEN` | no | generated | management bearer; written to `./.zen/node-token` |
| `NODE_ID` | no | `vpngate-1` / `warp-1` / `warp-wireproxy-1` | node identity |
| `PUBLIC_URL` | no | auto-detect | public URL used in the manifest |
| `EGRESS_MODE` | no | `auto` | `auto` = VPN/WARP egress; `direct` = host egress (CI smoke) |
| `ALLOW_DIRECT_FALLBACK` | no | vpngate `1`, warp `0` | fall back to host egress if the tunnel fails |
| `ASSETS_BASE_URL` | no | Release `v2026.11.27` | override asset source |
| `ZEN_PORT` | no | `18081` | loopback port for zen-direct |
| `EGRESS_PORT` | no | `18080` | loopback port for the egress proxy (sing-box / wireproxy) |
| `MAX_RUN_SEC` | no | `0` | rotate after N seconds; 0 disables |
| `PROBE_INTERVAL_SEC` | no | `300` | egress self-check interval |
| `LOG_DIR` | no | `./.zen` | logs and assets |
| `SINGBOX_GOMEMLIMIT` | no | `64MiB` | Go heap cap for sing-box (vpngate/warp) |
| `SINGBOX_GOGC` | no | `50` | sing-box GC percent |
| `WIREPROXY_GOMEMLIMIT` | no | `32MiB` | Go heap cap for wireproxy |
| `WIREPROXY_GOGC` | no | `50` | wireproxy GC percent |

vpngate additionally needs `python3` and `curl` on the host. warp and warp-wireproxy need no Python.

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

The console can register this host as a native node using the public URL + `/health` + `/v1`; the management endpoints are for start/stop/restart/rotate.

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

## Regenerate

```bash
node _build/build.js
node _build/build-wireproxy.js
```
