/**
 * dsh-auto-approver 策略层（纯函数，无副作用，便于单测与外部实现复用）。
 *
 * 裁决优先级（从高到低）：
 *   1. denyAlways 命中        → 'rejected'（黑名单永远拒绝）
 *   2. mode=off               → 'ask'（转人工）
 *   3. mode=allow-all         → 'allowed-once'（全部自动批准）
 *   4. mode=allowlist         → 命中 allowlist → 'allowed-once'；未命中 → 'ask'
 */

export const MODES = ['allow-all', 'allowlist', 'off']

/** 默认配置。 */
export function defaultConfig() {
  return {
    mode: 'allow-all',
    allowlist: [],
    denyAlways: [],
    logPath: undefined, // 默认由插件层解析为 ~/.dsh/auto-approver.log
  }
}

/** 校验配置形状，返回 { ok, error? }。 */
export function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'config 必须是对象' }
  if (cfg.mode !== undefined && !MODES.includes(cfg.mode)) {
    return { ok: false, error: `mode 应为 ${MODES.join('/')}，收到: ${cfg.mode}` }
  }
  for (const key of ['allowlist', 'denyAlways']) {
    if (cfg[key] !== undefined && !Array.isArray(cfg[key])) {
      return { ok: false, error: `${key} 应为数组` }
    }
  }
  return { ok: true }
}

/**
 * 对一次审批请求做策略裁决。
 * @param {object} cfg 插件配置（已合并默认值）
 * @param {object} req approval/request 事件 payload：{ toolName, reason, ... }
 * @returns {'allowed-once'|'rejected'|'ask'} 裁决：自动批准 / 自动拒绝 / 转人工
 */
export function decide(cfg, req) {
  const tool = String(req?.toolName || '')
  // 1. 黑名单永远拒绝（最高优先）
  if (Array.isArray(cfg.denyAlways) && cfg.denyAlways.includes(tool)) return 'rejected'
  // 2. 关闭 → 全转人工
  if (cfg.mode === 'off') return 'ask'
  // 3. allow-all → 全批
  if (cfg.mode === 'allow-all') return 'allowed-once'
  // 4. allowlist → 命中批，未命中转人工
  if (cfg.mode === 'allowlist') {
    return (Array.isArray(cfg.allowlist) && cfg.allowlist.includes(tool)) ? 'allowed-once' : 'ask'
  }
  return 'ask' // 未知 mode 保守转人工
}

/** 生成一行审计记录（JSON）。 */
export function auditLine(entry) {
  return JSON.stringify(entry)
}

/** 构造审计记录对象。 */
export function makeAuditEntry({ req, decision, sessionId, ts }) {
  return {
    ts: (ts || new Date()).toISOString(),
    sessionId: String(sessionId || req?.agent?.session?.id || ''),
    toolName: String(req?.toolName || ''),
    reason: String(req?.reason || ''),
    callId: String(req?.callId || ''),
    decision,
  }
}
