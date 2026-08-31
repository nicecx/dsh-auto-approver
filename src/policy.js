/**
 * dsh-auto-approver 策略层（纯函数，无副作用，便于单测与外部实现复用）。
 *
 * 裁决优先级（从高到低）：
 *   1. denyAlways 命中        → 'rejected'（黑名单永远拒绝，附 denyReasons 原因）
 *   2. mode=off               → 'ask'（转人工）
 *   3. mode=allow-all         → 'allowed-once'（全部自动批准）
 *   4. mode=allowlist         → 命中 allowlist → 'allowed-once'；未命中 → 'ask'
 *   5. mode=hermes            → 命中 allowlist → 'allowed-once'；
 *                              未命中 → 'hermes'（交 Hermes Pro 语义裁决）
 */

export const MODES = ['allow-all', 'allowlist', 'hermes', 'off']

/** 默认配置。 */
export function defaultConfig() {
  return {
    mode: 'allow-all',
    allowlist: [],
    denyAlways: [],
    denyReasons: {},   // 工具名 → 拒绝时反馈给 agent 的原因文本
    hermesModel: 'deepseek-v4-pro', // Hermes 裁决模型（Pro 最高能力）
    hermesTimeoutSecs: 90,          // Hermes 裁决超时（秒）
    feedbackOnReject: true,         // 拒绝时是否把原因 followup 回发起会话
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
  if (cfg.denyReasons !== undefined && (typeof cfg.denyReasons !== 'object' || Array.isArray(cfg.denyReasons))) {
    return { ok: false, error: 'denyReasons 应为对象（工具名 → 原因）' }
  }
  return { ok: true }
}

/**
 * 对一次审批请求做策略裁决（规则层，不含 Hermes 调用）。
 * @param {object} cfg 插件配置（已合并默认值）
 * @param {object} req approval/request 事件 payload：{ toolName, reason, ... }
 * @returns {'allowed-once'|'rejected'|'ask'|'hermes'}
 *   allowed-once 自动批准 / rejected 自动拒绝 / ask 转人工 / hermes 交 Hermes Pro 裁决
 */
export function decide(cfg, req) {
  const tool = String(req?.toolName || '')
  // 1. 黑名单永远拒绝（最高优先，Hermes 也无权放行）
  if (Array.isArray(cfg.denyAlways) && cfg.denyAlways.includes(tool)) return 'rejected'
  // 2. 关闭 → 全转人工
  if (cfg.mode === 'off') return 'ask'
  // 3. allow-all → 全批
  if (cfg.mode === 'allow-all') return 'allowed-once'
  // 4. allowlist 模式：命中批，未命中转人工
  if (cfg.mode === 'allowlist') {
    return (Array.isArray(cfg.allowlist) && cfg.allowlist.includes(tool)) ? 'allowed-once' : 'ask'
  }
  // 5. hermes 模式：白名单直接批，其余交 Hermes Pro 语义裁决
  if (cfg.mode === 'hermes') {
    if (Array.isArray(cfg.allowlist) && cfg.allowlist.includes(tool)) return 'allowed-once'
    return 'hermes'
  }
  return 'ask' // 未知 mode 保守转人工
}

/** 拒绝原因（供 followup 反馈）：denyReasons 优先，否则通用文案。 */
export function rejectReason(cfg, req) {
  const tool = String(req?.toolName || '')
  const custom = cfg.denyReasons?.[tool]
  if (custom) return String(custom)
  return `该工具在拒绝黑名单（denyAlways）中：${tool}。如确需执行，请人工在网页/iMessage 批准。`
}

/** 构造给 Hermes Pro 裁决的 prompt（含工具/原因/请求方会话，不含敏感上下文）。 */
export function buildHermesPrompt(cfg, req) {
  const tool = String(req?.toolName || '')
  const reason = String(req?.reason || '')
  return [
    '你是 DSH 审批裁决员。请对下面这次权限请求给出裁决。',
    '',
    `请求工具: ${tool}`,
    `请求原因: ${reason || '（未给出）'}`,
    '',
    '请只输出一行 JSON：{"decision":"allowed-once"|"rejected","reason":"一句话理由（若拒绝，说明哪里不好、建议怎么改）"}',
    '原则：危险操作（数据破坏、凭据外泄、不可逆删除）倾向拒绝；常规开发操作倾向批准。',
  ].join('\n')
}

/** 解析 Hermes 返回的裁决 JSON（容错：去代码块、取首个 JSON 对象）。 */
export function parseHermesVerdict(raw) {
  try {
    const text = String(raw || '')
    const m = text.match(/\{[\s\S]*?\}/)
    if (!m) return { ok: false, error: '无 JSON 输出' }
    const obj = JSON.parse(m[0])
    if (obj.decision === 'allowed-once' || obj.decision === 'rejected') {
      return { ok: true, decision: obj.decision, reason: String(obj.reason || '') }
    }
    return { ok: false, error: `decision 非法: ${obj.decision}` }
  } catch (e) {
    return { ok: false, error: `解析失败: ${e.message}` }
  }
}

/** 生成一行审计记录（JSON）。 */
export function auditLine(entry) {
  return JSON.stringify(entry)
}

/** 构造审计记录对象。 */
export function makeAuditEntry({ req, decision, sessionId, ts, note }) {
  return {
    ts: (ts || new Date()).toISOString(),
    sessionId: String(sessionId || req?.agent?.session?.id || ''),
    toolName: String(req?.toolName || ''),
    reason: String(req?.reason || ''),
    callId: String(req?.callId || ''),
    decision,
    ...(note ? { note } : {}),
  }
}
