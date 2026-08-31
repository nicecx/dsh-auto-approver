# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-08-31

### Added
- `approval/request` interception with `{ prepend: true, global: true }` — answers before relay/UI push, so auto-settled requests never disturb the human.
- Policy modes: `allow-all` (auto-approve everything), `allowlist` (auto-approve listed tools only), `off` (all to human); `denyAlways` blacklist wins over every mode.
- JSON-lines audit log (`~/.dsh/auto-approver.log` by default) recording every decision (ts, sessionId, toolName, reason, callId, decision).
- Pure policy layer (`src/policy.js`) with unit tests (8 tests: config validation, mode precedence, denyAlways priority, audit entry shape).
- Bilingual README (en/zh) with safety notes; MIT license.
