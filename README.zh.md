# dsh-auto-approver

> **DeepSeek Harness 的可配置审批自动代理。** 拦截 `approval/request`（可选含 `ask_user_question`），按策略裁决——规则层、可选的 **Hermes Pro 语义裁决**、或人工。每次裁决都写审计日志。

## 为什么需要它

DSH 在特权操作前会请求审批（文件写入、命令执行、`danger-full-access` 等）。在可信的自主环境里——或对已知安全的工具子集——这些弹窗纯属噪音。本宿主插件在 **relay/UI 推送之前**拦截每次审批请求，按策略裁决，并写完整审计日志。

它与 [dsh-reset-handoff](https://github.com/nicecx/dsh-reset-handoff) 互为镜像：那个插件把重启委托给外部运维 agent；这个把审批委托给本地策略。

## 工作原理

```
agent 请求权限
   → 'approval/request' 事件（宿主发出）
   → dsh-auto-approver（prepend，在 relay/UI 之前）
        │
        ├─ denyAlways 命中      → 'rejected'（不打扰人工；Hermes 也无权放行）
        ├─ mode=allow-all       → 'allowed-once'（不打扰人工）
        ├─ mode=allowlist       → 命中 → 'allowed-once'；未命中 → next()（转人工）
        ├─ mode=hermes          → allowlist 命中 → 'allowed-once'
        │                        否则 → Hermes Pro 语义裁决
        │                                （deepseek-v4-pro，90s 超时，fail-closed → 人工）
        └─ mode=off             → next()（全部转人工，插件惰性）
   → 每次裁决都追加到审计日志
   → 拒绝时还会把原因 followup 回发起会话（互动闭环）
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
    mode: 'hermes'           # allow-all | allowlist | hermes | off（默认 allow-all）
    allowlist: []            # 规则层自动批准的工具（hermes 模式：直接放行）
    denyAlways: []           # 永远拒绝的工具（最高优先，Hermes 也无权放行）
    denyReasons: {}          # 工具 → 拒绝原因文本（反馈给 agent）
    hermesModel: 'deepseek-v4-pro'   # 裁决模型（Pro = 最高能力）
    hermesTimeoutSecs: 90    # 裁决超时；失败 → 转人工（fail-closed）
    feedbackOnReject: true   # 拒绝时把原因 followup 回发起会话
    qnaMode: 'off'           # 'hermes' = ask_user_question 交 Hermes Pro 回答；'off' = 人工
    userGranted: []          # 背书信号（非放行卡）——见下
    logPath: ''              # 审计日志路径（默认 ~/.dsh/auto-approver.log）
```

| mode | 行为 |
| --- | --- |
| `allow-all` | 自动批准**一切**（含 `danger-full-access`）。仅限可信环境。 |
| `allowlist` | 只自动批准列出的工具，其余询问人工。 |
| `hermes` | 规则层（denyAlways / allowlist）+ **Hermes Pro 语义裁决**兜底。 |
| `off` | 插件惰性，全部转人工。 |

`denyAlways` 优先于一切 mode——列出的工具永远被拒（Hermes 也无权放行）。

### `userGranted` —— 背书信号，不是放行卡

`userGranted` 是传给 Hermes 裁决 prompt 的**软背书**（"用户已明确授权此工具——在业务合理且无数据破坏/凭据外泄风险时应倾向批准"）。它**不是**硬放行：

- `denyAlways` 仍优先于一切。
- Hermes 仍会拒绝危险操作（数据破坏、凭据外泄、不可逆删除）。
- **默认保持空数组**——放宽工具（如 `bash`、`write`）与最小权限原则冲突。只列用户明确点名的能力。

### 互动拒绝闭环

策略（或 Hermes）拒绝时，插件把原因 followup 回发起会话——agent 知道**哪里不好**，可改为更窄的权限/具体路径/明确命令后重试。iMessage/网页上的人工批准永远优先。

### 问答接管（可选）

`qnaMode: 'hermes'` 时，`ask_user_question` 也由 Hermes Pro 回答，不再打断人工。Hermes 看到问题与选项（或自由回答）后按 relay 回答格式返回选择；Hermes 不可用时回退人工。

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
