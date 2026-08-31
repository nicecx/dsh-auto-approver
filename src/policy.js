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
    qnaMode: 'off',                 // 'hermes'=ask_user_question 交 Hermes Pro 回答；'off'=转人工
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

/**
 * 解析 Hermes 返回的裁决 JSON（容错：装饰框/日志回显/示例 JSON 干扰）。
 *
 * 陷阱：Hermes oneshot 输出以 `Query: ...` 回显整个 prompt，而 prompt 里
 * 包含示例 JSON（`{"decision":"allowed-once"|"rejected",...}`，含 `|` 与
 * 未闭合引号）——若提取第一个 `{"decision"` 会命中示例导致解析失败。
 * 因此必须**从后往前**找（Hermes 的回答在输出末尾），且只接受 decision
 * 值为合法枚举的完整 JSON。
 */
export function parseHermesVerdict(raw) {
  try {
    const text = String(raw || '')
    // 从后往前找所有 {"decision" 位置
    let searchFrom = text.length
    while (true) {
      const idx = text.lastIndexOf('{"decision"', searchFrom)
      if (idx === -1) break
      // 尝试解析该位置的 JSON 对象
      const parsed = tryParseJsonAt(text, idx)
      if (parsed !== null && (parsed.decision === 'allowed-once' || parsed.decision === 'rejected')) {
        return { ok: true, decision: parsed.decision, reason: String(parsed.reason || '') }
      }
      // 死循环防护（Hermes 审核 20260831-001）：lastIndexOf 对负 fromIndex 钳为 0，
      // idx===0 且解析失败时 searchFrom=-1 → lastIndexOf 仍返回 0 → 无限循环。
      if (idx === 0) break
      searchFrom = idx - 1
    }
    return { ok: false, error: '无合法裁决 JSON 输出' }
  } catch (e) {
    return { ok: false, error: `解析失败: ${e.message}` }
  }
}

/** 尝试从 text[start] 解析一个平衡 JSON 对象；失败返回 null。 */
function tryParseJsonAt(text, start) {
  let depth = 0
  let inStr = false
  let end = -1
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end === -1) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
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

// ── QnA（ask_user_question 接管）──

/**
 * 构造给 Hermes Pro 回答用户问题的 prompt。
 * @param {object} cfg 配置
 * @param {Array} questions ask_user_question 的 arguments.questions
 * @param {string} [context] 可选：发起会话的简短上下文
 */
export function buildQnaPrompt(cfg, questions, context) {
  const lines = [
    '你是 DSH 的问答代理。用户（DSH 会话里的 agent）向人类提了以下问题，请以人类的立场给出最佳回答。',
    '若问题有选项，必须从选项中选择（可给序号或完整标签）；若允许多选且确实需要多个，用逗号分隔。',
    '若无选项（自由回答），给出简洁、具体、可执行的回答。',
    '',
    ...(context ? [`会话上下文: ${context}`] : []),
    '',
  ]
  questions.forEach((q, i) => {
    lines.push(`Q${i + 1} (id=${q.id}): ${q.question}`)
    if (q.options?.length) {
      lines.push(q.options.map((o, j) => `  ${j + 1}. ${o.label}${o.description ? `（${o.description}）` : ''}`).join('\n'))
    }
    if (q.multiSelect) lines.push('  （可多选，逗号分隔）')
  })
  lines.push('', '输出格式：每个问题一行 "qid: 选项序号或文本"，多问题用换行分隔。只输出回答，不要解释。')
  return lines.join('\n')
}

/**
 * 把 Hermes 的回答文本解析成 { answers: [{id, selected}] }（对齐 relay parseAnswer 语义）。
 * 每行 "qid: 选择"；无 qid 前缀的行作用于第一个问题。
 */
export function parseQnaVerdict(raw, questions) {
  const answers = []
  const text = String(raw || '').trim()
  if (text) {
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean)
    for (const line of lines) {
      const m = line.match(/^([^:=：]{1,64})[:=：]\s*([\s\S]+)$/)
      const qid = m ? m[1].trim() : null
      const choice = m ? m[2].trim() : line
      const q = qid
        ? questions.find((c) => String(c.id) === qid)
        : (answers.length === 0 ? questions[0] : null)
      if (!q) continue
      // 选项匹配：序号 或 标签
      const selected = []
      const parts = choice.split(/[,，、]/).map((p) => p.trim()).filter(Boolean)
      for (const p of parts) {
        const idx = Number(p)
        if (Number.isInteger(idx) && idx >= 1 && idx <= q.options.length) {
          selected.push(q.options[idx - 1].label)
        } else if (q.options.some((o) => o.label === p)) {
          selected.push(p)
        } else {
          selected.push(p) // 自由文本/自定义
        }
      }
      answers.push({ id: q.id, selected, ...(q.multiSelect ? {} : {}) })
      if (!qid) break // 无前缀只作用第一个问题
    }
  }
  // 补未回答问题
  for (const q of questions) {
    if (!answers.some((a) => a.id === q.id)) answers.push({ id: q.id, selected: [] })
  }
  return answers
}
