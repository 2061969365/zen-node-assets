# 已知问题与根因（2026-11-27）

记录本轮 WARP / VPNGate 原生节点排查结论，避免重复踩坑。

## 1. WARP 启动后频繁 rotate、chat 429

**现象**

```
watchdog: up429 0 -> 2 (threshold 1), rotating
rotate start reason=429
rotate done reason=429 egress=104.28.222.16
```

刚起来 20~90 秒就换一次 WARP 身份，连续多次。

**根因**

- 上游是 `https://opencode.ai/inference/v1`，返回的是 `FreeUsageLimitError`：
  `free-usage 429 ... turns=0, poisoned+rotate`。
- 免费额度按出口 IP / 会话计。WARP 出口是 Cloudflare 共享 IP（104.28.x.x 等），
  其中不少段已经被用爆。
- `zen-direct` 自己能 `poisoned+rotate` 换会话，但换不掉被限的出口 IP；
  只有外层换 WARP 身份/出口 IP 才可能绕开。
- 旧策略 `ROTATE_429_THRESHOLD=1`，启动阶段任何一次 429 都触发整机 rotate，
  于是形成启动即换 IP 的循环；换到干净 IP 后才稳定。

**修复**

- 启动先探测 `/v1/chat/completions`，200 才算就绪（见第 2 条）。
- `ROTATE_429_GRACE_SEC=90`：网关启动 90 秒内的 429 只更新基线，不触发 rotate。
- `warp` 默认 `prefer_ipv6`，优先走 WARP IPv6 出口；`warp-wireproxy` 显式
  `ResolveStrategy=ipv6`。
- 注意：`/health` 的 `egress_ip` 是 IPv4 echo 的结果，不代表 chat 实际走 v4。

**结论**：429 不是隧道故障，是上游对共享 WARP IP 的免费额度限制。若持续 429，
换 VPNGate（住宅 IP）比继续换 WARP 身份有效。

## 2. 启动没有 chat 200 探测

旧原生模板只做 `verifyEgress`（访问 ipify 拿 IP），隧道通就报 `running`，
即使 chat 实际 429。console 的 GitHub 模板起手会 probe chat 200，429 就重注册重试。

**修复**

- `BOOT_PROBE_TRIES=4`（0 关闭）、`BOOT_PROBE_TIMEOUT_SEC=90`。
- 非 200 时 `rotateEgress('429')` 后重启 gateway 再试；4 次失败进入 `phase=error`，
  watchdog 60 秒后重新 bootstrap。
- 只在 `EGRESS_MODE=auto` 下执行，CI 的 direct 冒烟不受影响。

## 3. DNS 泄漏 / 解析失败

- `warp` / `vpngate` 的 sing-box 配置原来没有 `dns` 块，走宿主机系统解析，
  既泄漏 DNS，也可能在受限环境解析失败。
- `warp-wireproxy` 通过 `DNS = 1.1.1.1` 让 wireproxy 的 netstack 在隧道内解析（UDP 53）。

**修复**

- sing-box 增加 DoH：`https://1.1.1.1/dns-query`，`detour` 指向隧道 endpoint
  （warp 用 `warp`，vpngate 用当前节点 tag）。
- `warp` 可用 `WARP_DNS` / `WARP_DNS_STRATEGY` 调整；vpngate 用 `VPNGATE_DNS`。

## 4. IPv6 没有真正生效

- `warp` 的 `.7` 配置里其实已有 v4+v6 地址，但没有 DNS 策略，实际出口一直选 v4；
  endpoint 还是 `engage.cloudflareclient.com` 域名。
- `warp-wireproxy` 早期为了绕 IPv6 握手超时，直接删掉了 v6 Address 和 `::/0`，
  变成纯 IPv4。

**修复**

- 保留 `Address = v4` + `Address = v6`，`AllowedIPs = 0.0.0.0/0, ::/0`。
- 外层 endpoint 固定 IPv4 `162.159.192.1:2408`（`WARP_ENDPOINT`），
  没有宿主机 IPv6 也能建隧道，隧道内 IPv6-only 目标可用。
- `warp`：`WARP_DNS_STRATEGY=prefer_ipv6`；`warp-wireproxy`：`[Resolve] ResolveStrategy=ipv6`。

## 5. wireproxy v1.1.3 的 ResolveStrategy 坑

v1.1.3 的 `ResolveAddrWithContext` 只处理 `ipv4` / `ipv6`，默认 `auto` 会得到空列表
并报 `no address found`。因此配置里必须显式写 `[Resolve] ResolveStrategy`，
不要依赖默认值。

## 6. NODE_TOKEN 每次重启都变（已修）

旧逻辑在未设置 `NODE_TOKEN` 时每次启动随机生成并覆盖 `.zen/node-token`，
面板里保存的旧 token 立即失效。现在使用固定默认值，`NODE_TOKEN` 环境变量可覆盖，
生效值写入 `.zen/node-token`。

## 7. 子进程日志无限增长（已修）

`node.log` 有轮转，但 `gateway.log`、`gateway.stdio.log`、`sing-box.log`、
`wireproxy.log`、`command.log` 等只追加。现在每 `LOG_SWEEP_INTERVAL_SEC`（600s）
按 `LOG_CHILD_MAX_MB`（默认 10MB）截断保留最后 128KB，并按 `LOG_MAX_AGE_DAYS`
（默认 7 天）清理。

## 版本对照

| 版本 | 内容 |
|---|---|
| `2026.11.27.5` | 自动 rotate（429 / egress / interval / maxrun） |
| `2026.11.27.6` | 子进程日志清理 |
| `2026.11.27.7` | NODE_TOKEN 固定，不再随机 |
| `2026.11.27.8` | 双栈 + 隧道内 DoH + 启动 chat 200 探测 + 429 grace |
| `2026.11.27.9` | warp 默认 `prefer_ipv6` |
| `2026.11.27.10` | wireproxy `[Resolve]`、更低内存默认、`/status.mem` |

## 运维建议

- 公网节点用 `NODE_TOKEN` 覆盖默认值；默认值在公开仓库里。
- 更新走 `POST /_zen/node/v1/update`，会自动生成 `index.js.bak`；失败可 `/rollback`。
- 持续 429 且 rotate 无效时，换 VPNGate 模板，不要无限重注册 WARP。
- `/status` 现在包含 `mem`（Node RSS/heap + gateway/egress 子进程 RSS），
  可直接观察内存占用。
