# dsh-auto-approver

> **Configurable auto-approval for DeepSeek Harness.** Intercepts `approval/request` and answers `allowed-once` / `rejected` by policy — so the human is only asked when the policy says so.

## Why

DeepSeek Harness asks for approval before privileged operations (file writes, command execution, `danger-full-access`, …). In a trusted, autonomous setup — or for a known-safe subset of tools — those prompts are pure noise. This host plugin intercepts every approval request **before** the relay/UI push and settles it by policy, with a full audit log.

It is the mirror image of [dsh-reset-handoff](https://github.com/nicecx/dsh-reset-handoff): that plugin delegates restarts to an external ops agent; this one delegates approvals to a local policy.

## How it works

```
agent requests permission
   → 'approval/request' event (host emits)
   → dsh-auto-approver (prepend, before relay/UI)
        │
        ├─ denyAlways hit        → 'rejected' (never prompts)
        ├─ mode=allow-all        → 'allowed-once' (never prompts)
        ├─ mode=allowlist        → hit → 'allowed-once'; miss → next() (human asked)
        └─ mode=off              → next() (all to human, plugin inert)
   → every decision is appended to the audit log
```

Registering with `{ prepend: true, global: true }` makes the plugin answer **before** dsh-relay pushes the prompt to iMessage/Web — an auto-approved request never disturbs the human.

## Install

```sh
dsh plugin --profile <profile> add github:nicecx/dsh-auto-approver
```

## Configuration

Override in your profile patch (`cordis.patch.yml`):

```yaml
- id: dsh-auto-approver
  name: 'dsh-auto-approver'
  config:
    mode: 'allowlist'        # allow-all | allowlist | off (default: allow-all)
    allowlist:               # tools auto-approved when mode=allowlist
      - calendar_add
      - reset_handoff
    denyAlways: []           # tools always rejected (highest priority)
    logPath: ''              # audit log path (default ~/.dsh/auto-approver.log)
```

| mode | behavior |
| --- | --- |
| `allow-all` | auto-approve **everything** (incl. `danger-full-access`). Use only in trusted environments. |
| `allowlist` | auto-approve only listed tools; everything else asks the human. **Recommended.** |
| `off` | plugin inert; everything goes to the human. |

`denyAlways` wins over every mode — a listed tool is always rejected.

## Audit log

Every decision is appended (JSON lines) to `~/.dsh/auto-approver.log`:

```json
{"ts":"...","sessionId":"...","toolName":"bash","reason":"...","callId":"...","decision":"allowed-once"}
```

## Safety notes

- `allow-all` auto-grants everything, including full-access commands. Prefer `allowlist` in anything less than a fully trusted single-user box.
- The relay/Web double-track is untouched: when the policy says `ask`, the human still decides on iMessage or the Web UI as before; manual approvals always win.
- The audit log is the complete record of auto-decisions — keep it.

## License

MIT
