/**
 * dsh-auto-approver — 审批自动代理（宿主级，跨会话共享）。
 *
 * 拦截 approval/request 事件，按可配置策略自动批准/拒绝，人工只在策略
 * 未覆盖时被询问（relay 照常推送 iMessage/网页）。
 *
 * 裁决优先级：denyAlways（永远拒绝）> mode（allow-all 全批 / allowlist
 * 白名单批 / off 全转人工）。每次裁决写入审计日志（~/.dsh/auto-approver.log）。
 *
 * 安全说明（重要）：
 *   - mode=allow-all 会**自动批准一切权限请求**（含 danger-full-access）。
 *     仅在你信任当前环境时使用；建议生产用 allowlist 只放行指定工具。
 *   - 本插件用 { prepend: true, global: true } 注册，抢在 relay 与宿主
 *     之前裁决；返回 'allowed-once'/'rejected' 会短路下游（relay 不再推送）。
 *   - 审计日志是唯一完整的自动裁决记录，保留以便事后核查。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultConfig, validateConfig, decide, makeAuditEntry } from './policy.js'

export const name = 'dsh-auto-approver'

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
      const decision = decide(config, req)
      const sessionId = String(req?.agent?.session?.id || '')
      audit(makeAuditEntry({ req, decision, sessionId }))

      if (decision === 'allowed-once') {
        ctx.logger?.info?.(
          `[dsh-auto-approver] 自动批准 ${req?.toolName}（会话 ${sessionId}）mode=${config.mode}`,
        )
        return 'allowed-once'
      }
      if (decision === 'rejected') {
        ctx.logger?.info?.(
          `[dsh-auto-approver] 自动拒绝 ${req?.toolName}（会话 ${sessionId}，黑名单）`,
        )
        return 'rejected'
      }
      // ask → 转人工（relay 推送 iMessage/网页，用户裁决）
      return next()
    }, { prepend: true, global: true })

    return () => { off() }
  }, 'dsh-auto-approver: intercept')

  ctx.logger?.info?.(
    `[dsh-auto-approver] loaded (mode=${config.mode}, allowlist=${config.allowlist.length}, deny=${config.denyAlways.length})`,
  )
}

// Cordis 4 requires every consumed service to be declared via "inject".
export const inject = []
apply.inject = []

// 纯函数/策略导出（供单测与外部实现复用）
export { defaultConfig, validateConfig, decide, makeAuditEntry, auditLine } from './policy.js'
