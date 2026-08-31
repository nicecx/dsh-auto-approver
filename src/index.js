/**
 * dsh-auto-approver — 审批自动代理（宿主级，跨会话共享）。
 *
 * 拦截 approval/request 事件，按可配置策略自动批准/拒绝；超出规则层时
 * 可交 Hermes Pro（deepseek-v4-pro 最高能力）做语义裁决。拒绝时把原因
 * followup 回发起会话（互动闭环：agent 知道哪里不好、可改正重试）。
 *
 * 裁决链（优先级从高到低）：
 *   denyAlways（黑名单，永远拒绝，Hermes 也无权放行）
 *     → mode 规则层（allow-all 全批 / allowlist 白名单批 / off 全转人工）
 *     → mode=hermes 未命中白名单 → 调 Hermes Pro 裁决
 *     → 人工（relay 照常推送 iMessage/网页）
 *
 * 安全说明（重要）：
 *   - mode=allow-all 会**自动批准一切**（含 danger-full-access）。仅限可信环境。
 *   - Hermes 裁决超时/不可用 → 转人工（fail-closed），绝不静默放行。
 *   - 每次裁决（含 Hermes 结果）写入审计日志 ~/.dsh/auto-approver.log。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import {
  defaultConfig, validateConfig, decide, rejectReason,
  buildHermesPrompt, parseHermesVerdict, makeAuditEntry,
} from './policy.js'

const execFileAsync = promisify(execFile)
const FEEDBACK_PREFIX = '[系统·审批代理]'

export const name = 'dsh-auto-approver'

/** 调 Hermes Pro 做一次语义裁决（oneshot，纯文本，不注入会话）。 */
async function askHermes(config, req) {
  const prompt = buildHermesPrompt(config, req)
  try {
    const { stdout } = await execFileAsync('hermes', ['chat', '-q', prompt, '--oneshot', '-m', config.hermesModel], {
      timeout: (config.hermesTimeoutSecs || 90) * 1000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return parseHermesVerdict(stdout)
  } catch (err) {
    return { ok: false, error: `Hermes 调用失败: ${err.message}` }
  }
}

/** 把反馈 followup 回发起会话（互动闭环）。 */
function feedbackToSession(ctx, sessionId, text) {
  try {
    const id = String(sessionId || '')
    if (!id) return false
    const agent = ctx.agents.get(id)
    if (!agent) return false
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: `${FEEDBACK_PREFIX}\n${text}` }],
      source: { kind: 'plugin', plugin: name, form: 'auto-approver' },
    })
    return true
  } catch {
    return false
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...defaultConfig(), ...(rawConfig || {}) }
  const v = validateConfig(config)
  if (!v.ok) {
    ctx.logger?.warn?.(`[dsh-auto-approver] 配置非法，按 off 处理: ${v.error}`)
    config.mode = 'off'
  }
  const logPath = config.logPath || path.join(os.homedir(), '.dsh', 'auto-approver.log')

  const audit = (entry) => {
    try {
      mkdirSync(path.dirname(logPath), { recursive: true })
      appendFileSync(logPath, JSON.stringify(entry) + '\n')
    } catch { /* 审计失败不阻断裁决 */ }
  }

  ctx.effect(() => {
    // 抢在 relay（prepend）与宿主 apiproxy 之前裁决审批。
    const off = ctx.on('approval/request', async (req, next) => {
      const sessionId = String(req?.agent?.session?.id || '')
      let decision = decide(config, req)
      let note

      // 规则层判 hermes → 调 Hermes Pro 语义裁决
      if (decision === 'hermes') {
        const verdict = await askHermes(config, req)
        if (verdict.ok) {
          decision = verdict.decision
          note = `hermes: ${verdict.reason}`
        } else {
          // Hermes 不可用 → 转人工（fail-closed，绝不静默放行）
          decision = 'ask'
          note = `hermes 裁决不可用(${verdict.error})→ 转人工`
          ctx.logger?.warn?.(`[dsh-auto-approver] ${note}`)
        }
      }

      audit(makeAuditEntry({ req, decision, sessionId, note }))

      if (decision === 'allowed-once') {
        ctx.logger?.info?.(
          `[dsh-auto-approver] 批准 ${req?.toolName}（会话 ${sessionId}）mode=${config.mode}${note ? ` ${note}` : ''}`,
        )
        return 'allowed-once'
      }
      if (decision === 'rejected') {
        ctx.logger?.info?.(
          `[dsh-auto-approver] 拒绝 ${req?.toolName}（会话 ${sessionId}）${note ? note : '黑名单'}`,
        )
        // 互动闭环：拒绝时把原因反馈回发起会话（agent 可改正重试）
        if (config.feedbackOnReject !== false) {
          const why = note && note.startsWith('hermes:')
            ? note.slice('hermes: '.length)
            : rejectReason(config, req)
          feedbackToSession(ctx, sessionId, `你的「${req?.toolName}」请求被审批代理拒绝。\n原因: ${why}\n建议: 按原因修改后重新请求；如确需执行，请人工在网页/iMessage 批准。`)
        }
        return 'rejected'
      }
      // ask → 转人工（relay 推送 iMessage/网页，用户裁决）
      return next()
    }, { prepend: true, global: true })

    return () => { off() }
  }, 'dsh-auto-approver: intercept')

  ctx.logger?.info?.(
    `[dsh-auto-approver] loaded (mode=${config.mode}, allowlist=${config.allowlist.length}, deny=${config.denyAlways.length}, hermes=${config.mode === 'hermes' ? config.hermesModel : '-'})`,
  )
}

// Cordis 4 requires every consumed service to be declared via "inject".
// 本插件消费 agents（拒绝反馈 followup 回发起会话）。
export const inject = ['agents']
apply.inject = ['agents']

// 纯函数/策略导出（供单测与外部实现复用）
export {
  defaultConfig, validateConfig, decide, rejectReason,
  buildHermesPrompt, parseHermesVerdict, makeAuditEntry, auditLine,
} from './policy.js'
