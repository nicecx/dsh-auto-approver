# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-08-31

### Added
- `approval/request` interception with `{ prepend: true, global: true }` — answers before relay/UI push, so auto-settled requests never disturb the human.
- Policy modes: `allow-all` (auto-approve everything), `allowlist` (listed tools only), `hermes` (rule layer + Hermes Pro semantic verdict, 90s timeout, fail-closed to human), `off` (all to human); `denyAlways` blacklist wins over every mode.
- **Hermes mode** (`mode: 'hermes'`, model `deepseek-v4-pro`): for requests not settled by the rule layer, calls `hermes chat --oneshot` for a semantic verdict; unavailable/timeout → human (fail-closed, never silently granted).
- **Interactive reject loop** (`feedbackOnReject`): on reject, the reason is followed up into the requesting session so the agent can retry with a corrected request; `denyReasons` map provides per-tool reasons.
- **QnA takeover** (`qnaMode: 'hermes'`): `ask_user_question` answered by Hermes Pro, parsed to the relay answer format; falls back to human when Hermes is unavailable.
- **`userGranted` endorsement signal**: soft "user authorized this tool" hint injected into the Hermes verdict prompt; NOT a bypass card — `denyAlways` still wins, dangerous operations still rejected, default empty.
- JSON-lines audit log (`~/.dsh/auto-approver.log`): every decision records ts, sessionId, toolName, reason, callId, decision (+ `note` for Hermes verdicts).
- Pure policy layer (`src/policy.js`) with 22 unit tests (config validation, mode precedence, denyAlways priority, Hermes verdict parsing incl. framed-output and infinite-loop guards, QnA parsing, userGranted branches).
- Bilingual README (en/zh) with safety notes; MIT license.

### Fixed
- `parseHermesVerdict`: robust to Hermes framed output (`╭─ ⚕ Hermes ─╮`), prompt echo containing example JSON, and Title-line duplication — scans from the end for a valid `{"decision"}` JSON with whitelisted enum values.
- Infinite-loop guard: `lastIndexOf` clamps negative `fromIndex` to 0, so a failing parse at index 0 previously looped forever; added `if (idx === 0) break` (found by Hermes review 20260831-001).
