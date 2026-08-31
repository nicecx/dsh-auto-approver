# dsh-auto-approver

> **Configurable auto-approval for DeepSeek Harness.** Intercepts `approval/request` (and optionally `ask_user_question`) and answers by policy — rule layer, an optional **Hermes Pro semantic verdict**, or the human. Every decision is audit-logged.

## Why

DeepSeek Harness asks for approval before privileged operations (file writes, command execution, `danger-full-access`, …). In a trusted, autonomous setup — or for a known-safe subset of tools — those prompts are pure noise. This host plugin intercepts every approval request **before** the relay/UI push and settles it, with a full audit log and an interactive reject loop (the agent is told *why* it was rejected and can retry).

It is the mirror image of [dsh-reset-handoff](https://github.com/nicecx/dsh-reset-handoff): that plugin delegates restarts to an external ops agent; this one delegates approvals to a local policy and/or Hermes.

## How it works

```
agent requests permission
   → 'approval/request' event (host emits)
   → dsh-auto-approver (prepend, before relay/UI)
        │
        ├─ denyAlways hit        → 'rejected' (never prompts; Hermes cannot override)
        ├─ mode=allow-all        → 'allowed-once' (never prompts)
        ├─ mode=allowlist        → hit → 'allowed-once'; miss → next() (human asked)
        ├─ mode=hermes           → allowlist hit → 'allowed-once'
        │                          else → Hermes Pro semantic verdict
        │                                  (deepseek-v4-pro, 90s timeout, fail-closed → human)
        └─ mode=off              → next() (all to human, plugin inert)
   → every decision is appended to the audit log
   → 'rejected' also follows up the reason to the requesting session
```

Registering with `{ prepend: true, global: true }` makes the plugin answer **before** dsh-relay pushes the prompt to iMessage/Web — an auto-settled request never disturbs the human.

### QnA takeover (optional)

With `qnaMode: 'hermes'`, `ask_user_question` is also answered by Hermes Pro instead of interrupting the human. Hermes sees the question and its options (or free-form) and returns a choice per the relay answer format; if Hermes is unavailable it falls back to the human.

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
    mode: 'hermes'           # allow-all | allowlist | hermes | off (default: allow-all)
    allowlist: []            # tools auto-approved (rule layer; hermes mode: direct pass)
    denyAlways: []           # tools always rejected (highest priority, Hermes cannot override)
    denyReasons: {}          # tool → reject reason text fed back to the agent
    hermesModel: 'deepseek-v4-pro'   # verdict model (Pro = highest capability)
    hermesTimeoutSecs: 90    # verdict timeout; on failure → human (fail-closed)
    feedbackOnReject: true   # followup the reject reason to the requesting session
    qnaMode: 'off'           # 'hermes' = ask_user_question answered by Hermes Pro; 'off' = human
    userGranted: []          # endorsement signal (NOT a bypass card) — see below
    logPath: ''              # audit log path (default ~/.dsh/auto-approver.log)
```

| mode | behavior |
| --- | --- |
| `allow-all` | auto-approve **everything** (incl. `danger-full-access`). Trusted environments only. |
| `allowlist` | auto-approve only listed tools; everything else asks the human. |
| `hermes` | rule layer (denyAlways / allowlist) + **Hermes Pro semantic verdict** for the rest. |
| `off` | plugin inert; everything goes to the human. |

### `userGranted` — endorsement signal, not a bypass card

`userGranted` is a *soft* endorsement passed into the Hermes verdict prompt ("the user explicitly authorized this tool — lean toward approval when the operation is reasonable and carries no data-destruction / credential-exfiltration risk"). It is **not** a hard allow:

- `denyAlways` still wins over everything.
- Hermes still rejects dangerous operations (data destruction, credential exfiltration, irreversible deletes).
- **Keep it empty by default** — adding broad tools (`bash`, `write`) conflicts with the least-privilege principle. Only list capabilities the user explicitly named.

## Interactive reject loop

When the policy (or Hermes) rejects, the plugin follows the reason back into the requesting session, so the agent knows *what* was wrong and can retry with a corrected request (e.g. narrower permission, concrete path, specific command). Manual approval on iMessage/Web always wins.

## Audit log

Every decision is appended (JSON lines) to `~/.dsh/auto-approver.log`:

```json
{"ts":"...","sessionId":"...","toolName":"bash","reason":"...","callId":"...","decision":"allowed-once"}
```

Hermes verdicts also carry the reason in `note` (e.g. `hermes: ...`).

## Safety notes

- `allow-all` auto-grants everything, including full-access commands. Prefer `allowlist`/`hermes` in anything less than a fully trusted single-user box.
- `hermes` mode is **fail-closed**: if Hermes is unavailable or times out, the request goes to the human — never silently granted.
- The relay/Web double-track is untouched: when the policy says `ask`, the human still decides on iMessage or the Web UI; manual approvals always win.
- The audit log is the complete record of auto-decisions — keep it.

## License

MIT
