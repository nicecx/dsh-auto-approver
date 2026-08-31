# dsh-auto-approver

> **DeepSeek Harness 的可配置审批自动代理。** 拦截 `approval/request`，按策略自动批准（`allowed-once`）/拒绝（`rejected`）——策略未覆盖时才询问人工。

## 为什么需要它

DSH 在特权操作前会请求审批（文件写入、命令执行、`danger-full-access` 等）。在可信的自主环境里——或对已知安全的工具子集——这些弹窗纯属噪音。本宿主插件在 **relay/UI 推送之前**拦截每次审批请求，按策略裁决，并写完整审计日志。

它与 [dsh-reset-handoff](https://github.com/nicecx/dsh-reset-handoff) 互为镜像：那个插件把重启委托给外部运维 agent；这个把审批委托给本地策略。

## 工作原理

```
agent 请求权限
   → 'approval/request' 事件（宿主发出）
   → dsh-auto-approver（prepend，在 relay/UI 之前）
        │
        ├─ denyAlways 命中      → 'rejected'（不打扰人工）
        ├─ mode=allow-all       → 'allowed-once'（不打扰人工）
        ├─ mode=allowlist       → 命中 → 'allowed-once'；未命中 → next()（转人工）
        └─ mode=off             → next()（全部转人工，插件惰性）
   → 每次裁决都追加到审计日志
```

以 `{ prepend: true, global: true }` 注册，让插件**先于** dsh-relay 推送（iMessage/网页）回答——自动批准的操作不会打扰你。

## 安装

```sh
dsh plugin --profile <profile> add github:nicecx/dsh-auto-approver
```

## 配置

在 profile patch（`cordis.patch.yml`）中覆盖：

```yaml
- id: dsh-auto-approver
  name: 'dsh-auto-approver'
  config:
    mode: 'allowlist'        # allow-all | allowlist | off（默认 allow-all）
    allowlist:               # mode=allowlist 时自动批准的工具
      - calendar_add
      - reset_handoff
    denyAlways: []           # 永远拒绝的工具（最高优先）
    logPath: ''              # 审计日志路径（默认 ~/.dsh/auto-approver.log）
```

| mode | 行为 |
| --- | --- |
| `allow-all` | 自动批准**一切**（含 `danger-full-access`）。仅限可信环境。 |
| `allowlist` | 只自动批准列出的工具，其余询问人工。**推荐。** |
| `off` | 插件惰性，全部转人工。 |

`denyAlways` 优先于一切 mode——列出的工具永远被拒。

## 审计日志

每次裁决以 JSON 行追加到 `~/.dsh/auto-approver.log`：

```json
{"ts":"...","sessionId":"...","toolName":"bash","reason":"...","callId":"...","decision":"allowed-once"}
```

## 安全说明

- `allow-all` 自动放行一切，包括 full-access 命令。非完全可信的单用户机器请用 `allowlist`。
- relay/网页双轨不受影响：策略判定 `ask` 时，你仍可在 iMessage 或网页上裁决；人工裁决永远优先。
- 审计日志是自动裁决的完整记录，请保留。

## License

MIT
