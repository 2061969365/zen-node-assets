# Console 原生节点模板推送方案

目标：让 zen-console 在保留现有 GitHub 仓库节点（repo 节点）的同时，纳管单文件 Node 原生节点，并用现有的“模板推送”入口把新版 `index.js` 推到节点上。

本文以 `zen-console` 当前源码（`F:\worker\zen-console`）为准；原生节点端协议已由 `zen-node-assets` 的 `2026.11.27.3` 实现。

---

## 1. 总体设计

节点分两类：

| kind | 运行位置 | 模板载体 | 推送方式 |
|---|---|---|---|
| `repo`（现有） | GitHub Actions runner | 节点仓库里的 `gateway.yml` / `run-gateway.sh` / `bin/zen-direct` / `TEMPLATE_VERSION` | GitHub Contents API 提交 + 可选 dispatch |
| `native`（新增） | 任意 Node 主机（KataBump/Render/Railway 等） | 主机上的 `index.js` | 节点管理 API `POST /_zen/node/v1/update` |

对用户保持一个入口：`POST /api/template/push` 和 `POST /api/template/diff`，内部按 `node.Kind` 分流。

原生节点不参与 GitHub API 调用，不要求 `account_id`、`repo`、`workflow_file`、`branch`。健康探测和数据面仍然走现有的 `domain` → `/health`、`/v1`。

---

## 2. 节点端协议（已实现）

`zen-node-assets` 三个模板均支持：

- `GET /_zen/node/v1/manifest`
  - `templateType`
  - `version`
  - `capabilities` 包含 `update`、`rollback`
  - `update.protocol = "1"`、`update.maxBytes`、`update.restartModes`
- `POST /_zen/node/v1/update`
- `POST /_zen/node/v1/rollback`

### 2.1 更新请求

Header：`Authorization: Bearer <NODE_TOKEN>`，`Content-Type: application/json`。

```json
{
  "template": "warp-wireproxy",
  "version": "2026.11.28.1",
  "sha256": "<64位小写hex>",
  "content": "<index.js 的 base64>",
  "restart": true,
  "restartMode": "exec"
}
```

也支持 `url` 代替 `content`（仅 https；本机 `http://127.0.0.1` 例外），但 console 推送建议直接用 `content`，不依赖节点能否访问 console。

`restartMode`：

- `exec`：节点关闭监听后 spawn 新进程，自己退出。适合没有进程管理器的普通主机。
- `exit`：替换后以 0 退出，依赖平台自动重启。适合 Render/Railway/Koyeb/Fly/Zeabur。
- `crash`：替换后以 1 退出，依赖面板按“崩溃”重启。适合 Pterodactyl/KataBump。
- 不传时按环境自动判断。

### 2.2 更新响应

```json
{
  "ok": true,
  "from": "2026.11.27.3",
  "to": "2026.11.28.1",
  "sha256": "...",
  "restart": true,
  "restartMode": "crash"
}
```

- `202`：已替换并安排重启。
- `200`：已替换，`restart=false`，等下次手动重启生效。
- `400`：sha/template/version 标记/语法校验失败。
- `401`：token 错误。
- `409`：正在更新，或脚本路径不可用。

节点端行为：

1. 校验 `template` 与自身一致。
2. 校验 `sha256`。
3. 校验文件内 `const TEMPLATE = '...'` 和 `const VERSION = '...'`。
4. `node --check` 语法检查。
5. 备份当前文件为 `index.js.bak`。
6. 原子替换 `index.js`。
7. 按 `restartMode` 重启。

回滚：

```json
POST /_zen/node/v1/rollback
{"restart": true}
```

把 `index.js.bak` 写回并重启。

---

## 3. 数据模型

### 3.1 `internal/model/model.go`

新增：

```go
const (
    NodeKindRepo   = "repo"
    NodeKindNative = "native"

    TemplateTypeWarpWireproxy = "warp-wireproxy"
)

type Node struct {
    // 现有字段...
    Kind         string `json:"kind"`          // repo | native
    BaseURL      string `json:"baseUrl"`       // native 节点公网地址
    NodeToken    string `json:"-"`             // native 管理 token
    RestartMode  string `json:"restartMode"`   // auto | exec | exit | crash
}
```

`Kind` 为空时按 `repo` 处理，保证旧数据兼容。

### 3.2 `internal/store/store.go`

建表增加列：

```sql
kind TEXT NOT NULL DEFAULT 'repo',
base_url TEXT NOT NULL DEFAULT '',
node_token TEXT NOT NULL DEFAULT '',
restart_mode TEXT NOT NULL DEFAULT 'auto'
```

迁移函数（放在现有 `migrateNodes*` 系列里）：

```go
func migrateNodesNative(db *sql.DB) error {
    for _, m := range []struct{ name, ddl string }{
        {"kind", `ALTER TABLE nodes ADD COLUMN kind TEXT NOT NULL DEFAULT 'repo'`},
        {"base_url", `ALTER TABLE nodes ADD COLUMN base_url TEXT NOT NULL DEFAULT ''`},
        {"node_token", `ALTER TABLE nodes ADD COLUMN node_token TEXT NOT NULL DEFAULT ''`},
        {"restart_mode", `ALTER TABLE nodes ADD COLUMN restart_mode TEXT NOT NULL DEFAULT 'auto'`},
    } {
        // hasColumn + ALTER TABLE
    }
    return nil
}
```

`nodeCols`、`scanNode`、`AddNode`、`UpdateNode` 都要带上这四列。

### 3.3 `UNIQUE(repo)` 的处理

现有表是 `UNIQUE(repo)`，原生节点没有仓库。不要重建表，给原生节点写一个稳定的合成 key：

```go
repo = "native/" + strings.ToLower(strings.TrimSpace(name))
```

或者 `native/<uuid>`。这样：

- 不破坏现有唯一索引；
- GitHub 相关代码看到 `native/` 前缀可以直接跳过；
- 展示层用 `name` / `baseUrl`，不展示这个合成 repo。

---

## 4. 原生模板仓库

在 console 可执行文件旁增加：

```text
native-template/
  vpngate/index.js
  warp/index.js
  warp-wireproxy/index.js
```

`LoadNativeTemplates(dir)`：

1. 读取每个文件；
2. 用正则取 `const VERSION = '...'`；
3. 计算 `sha256`；
4. 缓存 `{type, version, bytes, sha256}`。

版本号必须与 `index.js` 内一致。推送时以文件内的 `VERSION` 为准，不单独维护 `TEMPLATE_VERSION`。

可选的 `native-template/manifest.json` 只用于展示和校验，不作为唯一来源。

---

## 5. Provision 层

### 5.1 `internal/provision/template.go`

新增：

```go
type NativeTemplate struct {
    Type    string
    Version string
    Bytes   []byte
    SHA256  string
}

func LoadNativeTemplates(dir string) (map[string]*NativeTemplate, error)
```

`LoadTemplates` 保持只加载 repo 模板；原生模板单独加载，避免把 `index.js` 塞进 `RequiredFiles` 校验。

### 5.2 `internal/provision/provision.go`

`Push` 的 worker 内按 `n.Kind` 分流：

```go
if n.Kind == model.NodeKindNative {
    warn, err = p.pushNativeNode(ctx, n, restart)
} else {
    warn, err = p.pushNode(ctx, n, restart)
}
```

`pushNativeNode` 伪代码：

```go
func (p *Provisioner) pushNativeNode(ctx context.Context, n *model.Node, restart bool) (string, error) {
    tmpl := p.nativeTemplates[n.TemplateType]
    if tmpl == nil {
        return "", fmt.Errorf("provision: 未知原生模板 %q", n.TemplateType)
    }

    base := strings.TrimRight(n.BaseURL, "/")
    manifest, err := p.nativeGet(ctx, base, n.NodeToken, "/_zen/node/v1/manifest")
    if err != nil {
        return "", fmt.Errorf("%s: 读取 manifest: %w", n.Name, err)
    }
    if manifest.TemplateType != n.TemplateType {
        return "", fmt.Errorf("%s: 模板类型不一致（节点 %s，期望 %s）",
            n.Name, manifest.TemplateType, n.TemplateType)
    }
    if manifest.Version == tmpl.Version {
        // 已是最新
        return "", nil
    }

    body := map[string]any{
        "template":    n.TemplateType,
        "version":     tmpl.Version,
        "sha256":      tmpl.SHA256,
        "content":     base64.StdEncoding.EncodeToString(tmpl.Bytes),
        "restart":     restart,
        "restartMode": n.RestartMode, // auto 时传空
    }
    if err := p.nativePost(ctx, base, n.NodeToken, "/_zen/node/v1/update", body); err != nil {
        return "", fmt.Errorf("%s: 推送: %w", n.Name, err)
    }

    if !restart {
        n.TemplateVersion = tmpl.Version
        _ = p.st.UpdateNode(n)
        return "已暂存，等待手动重启", nil
    }

    // 轮询 manifest，等新版本上线
    deadline := time.Now().Add(90 * time.Second)
    for time.Now().Before(deadline) {
        m, err := p.nativeGet(ctx, base, n.NodeToken, "/_zen/node/v1/manifest")
        if err == nil && m.Version == tmpl.Version {
            n.TemplateVersion = tmpl.Version
            n.LastCommitSHA = tmpl.SHA256
            _ = p.st.UpdateNode(n)
            _ = p.st.AddEvent(&model.Event{
                NodeID: n.ID, Kind: "template_pushed",
                Detail: fmt.Sprintf("%s %s -> %s (native)", n.Name, manifest.Version, tmpl.Version),
            })
            return "", nil
        }
        time.Sleep(2 * time.Second)
    }
    return "", fmt.Errorf("%s: 推送后 90s 内未上线 %s", n.Name, tmpl.Version)
}
```

`Diff` 同理：原生节点拉 manifest，比较 `manifest.version` 与本地模板版本，返回 `from/to/changed`，不访问 GitHub。

### 5.3 HTTP 客户端

```go
timeout := 10 * time.Second
client := &http.Client{Timeout: timeout}
req.Header.Set("Authorization", "Bearer "+token)
req.Header.Set("Content-Type", "application/json")
```

- 只允许 `https://`；本机测试允许 `http://127.0.0.1` / `localhost`。
- 不跟随跨域重定向，或限制为同 host。
- 错误信息里不能带 token。
- 对 5xx/网络错误重试 2 次；400/401/409 不重试。

---

## 6. API 层

### 6.1 创建原生节点

`POST /api/nodes`：

```json
{
  "kind": "native",
  "name": "kata-warp-1",
  "domain": "https://xxx.katabump.example",
  "baseUrl": "https://xxx.katabump.example",
  "nodeToken": "....",
  "templateType": "warp-wireproxy",
  "restartMode": "crash"
}
```

校验：

- `kind=native` 时忽略 `repo` / `accountId` / `workflowFile` / `branch` / `tunnelToken`；
- `baseUrl` 必填，https（本机例外）；
- `nodeToken` 必填；
- `templateType` ∈ `vpngate | warp | warp-wireproxy`；
- `restartMode` ∈ `auto | exec | exit | crash`；
- 合成 `repo = native/<slug>`。

创建后不调用 GitHub，不 dispatch，直接返回节点；第一次探测由现有 probe 循环完成。

### 6.2 修改原生节点

`PATCH /api/nodes/{id}` 对 native 只允许：

- `name`
- `domain`
- `baseUrl`
- `nodeToken`（留空表示不改）
- `templateType`
- `restartMode`
- `weight` / `notes`

禁止改 `repo` / `accountId` / `workflowFile` / `branch`。

### 6.3 模板 diff / push / rollback

- `GET /api/template/diff`：按 kind 分流；原生节点返回 `{nodeId, name, kind:"native", from, to, changed}`。
- `POST /api/template/push`：现有 handler 不动，`prov.Push` 分流。
- `POST /api/template/rollback`：native 节点调用 `/_zen/node/v1/rollback`，然后轮询 manifest 确认版本回退；repo 节点走现有 commit 回滚。
- `POST /api/nodes/{id}/apply`：native 可转发到 `/_zen/node/v1/apply`（运行参数），也可以先只支持模板推送。

### 6.4 启停

原生节点没有 GitHub workflow：

- `POST /api/nodes/{id}/start|stop` 对 native 返回 400 或改成转发 `/_zen/node/v1/start|stop`；
- 建议第一阶段只允许模板推送和探活，启停后续再加。

---

## 7. 前端

### 7.1 新建节点页

增加节点类型选择：

```text
( ) GitHub 仓库节点
(•) 原生节点
```

原生节点字段：

- 名称
- 公网域名 / Base URL
- NODE_TOKEN
- 模板类型：VPNGate / WARP / WARP-wireproxy
- 重启方式：自动 / exec / exit / crash

### 7.2 节点列表 / 详情

- 列表加 `native` 徽标；
- 详情页隐藏 GitHub run、commit 回滚；
- 显示 `模板版本`、`最近推送`、`节点 /health`；
- 增加“回滚到上一版”按钮（调用 rollback）。

### 7.3 升级页

- 选择节点时 repo 和 native 可以混选；
- diff 表显示 `kind`、`当前版本`、`目标版本`；
- 推送进度沿用现有 operation 进度；
- 失败节点单独列出，不阻断其他节点。

---

## 8. 现有逻辑需要加的保护

以下位置遇到 `node.Kind == native` 必须直接跳过 GitHub：

- `internal/nodes/manager.go` 的 run 轮询、dispatch、cancel；
- `internal/provision/provision.go` 的 `diffNode`、`CommitFiles`、`restartNode`、`rollback`；
- `internal/api/server.go` 的 run/cancel/rollback/migrate；
- 任何用 `n.Repo` 调 GitHub 的地方。

建议在 `nodes.Manager` 和 `provision` 入口统一加：

```go
func isRepoNode(n *model.Node) bool {
    return n.Kind == "" || n.Kind == model.NodeKindRepo
}
```

---

## 9. 测试

### 9.1 单元测试

- `native` 创建校验：缺 baseUrl/token、非法 templateType、非法 restartMode。
- `pushNativeNode` 用 `httptest.Server` 模拟：
  - manifest 返回旧版本；
  - update 校验 body 的 template/sha256/content；
  - update 后 manifest 返回新版本；
  - 90s 超时路径（用短超时注入）。
- `rollback` 调用与版本确认。
- 混选 repo + native 的 Push，确认 repo 走 GitHub、native 走 HTTP。
- token 不出现在日志/事件/错误里。

### 9.2 手工验收

1. 部署 `warp-wireproxy/index.js`（KataBump，`SERVER_PORT` 自动识别）。
2. console 新建 native 节点，模板选 `warp-wireproxy`，重启方式 `crash`。
3. 等 `/health` 变绿。
4. 把 `native-template/warp-wireproxy/index.js` 换成 `2026.11.28.1`。
5. 升级页 diff 显示旧→新，推送。
6. 观察节点日志出现 `self-update staged`，面板版本变为新版本。
7. 点回滚，版本回到 `2026.11.27.3`。
8. 检查节点目录：`index.js`、`index.js.bak`。

---

## 10. 上线顺序

1. **先发节点端**：三个 `index.js` 已是 `2026.11.27.3`，支持 update/rollback。
2. **console 后端**：模型、迁移、native 模板加载、push/diff 分流、测试。
3. **console 前端**：新建/详情/升级页。
4. **灰度**：只给一个测试 native 节点推送，确认 KataBump 上 `crash` 模式能自动拉起。
5. **全量**：现有 repo 节点逻辑不变；native 节点逐步接入。

回滚方案：

- 升级 console 前备份 `zen-console.db` 和旧二进制；
- 新列都是 additive，旧 console 读新库时忽略未知列；
- native 推送失败不会影响 repo 节点；
- 节点侧保留 `index.js.bak`，可手动或 API 回滚。

---

## 11. 关键文件清单

| 文件 | 改动 |
|---|---|
| `internal/model/model.go` | `Node.Kind/BaseURL/NodeToken/RestartMode`，`TemplateTypeWarpWireproxy` |
| `internal/store/store.go` | 建表列、迁移、scan/insert/update |
| `internal/store/state.go` | 导入/导出新列 |
| `internal/provision/template.go` | `NativeTemplate`、`LoadNativeTemplates` |
| `internal/provision/provision.go` | `Push` 分流、`pushNativeNode`、`Diff` 分流 |
| `internal/api/server.go` | 创建/修改校验、native 保护、rollback |
| `internal/nodes/manager.go` | native 跳过 GitHub 轮询 |
| `web/pages/create.js` | 节点类型与 native 字段 |
| `web/pages/node.js` | native 详情、回滚 |
| `web/pages/upgrade.js` | 混选、diff、推送 |
| `native-template/*/index.js` | 三套模板源文件 |
| `*_test.go` | native push/diff/rollback 测试 |

---

## 12. 最小可用版本（如果时间紧）

只做以下四件事即可跑通：

1. `Node.Kind` + `BaseURL` + `NodeToken` + `RestartMode` 四个字段和迁移。
2. 创建/修改 API 支持 native。
3. `POST /api/template/push` 对 native 调 `/_zen/node/v1/update`，用本地 `native-template/<type>/index.js` 的 base64。
4. 升级页能选中 native 并显示推送结果。

diff、rollback、启停转发可以放到第二阶段。
