import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultConfig, validateConfig, decide, makeAuditEntry,
  rejectReason, buildHermesPrompt, parseHermesVerdict,
  buildQnaPrompt, parseQnaVerdict,
} from '../src/policy.js'

const mkReq = (toolName, reason = 'r', callId = 'c1') => ({
  toolName, reason, callId,
  agent: { session: { id: 'session-test' } },
})

test('默认配置为 allow-all', () => {
  const c = defaultConfig()
  assert.equal(c.mode, 'allow-all')
  assert.deepEqual(c.allowlist, [])
  assert.deepEqual(c.denyAlways, [])
})

test('validateConfig 拒绝非法 mode/数组', () => {
  assert.equal(validateConfig({ mode: 'bogus' }).ok, false)
  assert.equal(validateConfig({ allowlist: 'not-array' }).ok, false)
  assert.equal(validateConfig({ mode: 'allowlist' }).ok, true)
  assert.equal(validateConfig(null).ok, false)
})

test('denyAlways 黑名单优先于 allow-all', () => {
  const c = { ...defaultConfig(), mode: 'allow-all', denyAlways: ['bash'] }
  assert.equal(decide(c, mkReq('bash')), 'rejected')
  assert.equal(decide(c, mkReq('read')), 'allowed-once')
})

test('allow-all 全批', () => {
  const c = { ...defaultConfig(), mode: 'allow-all' }
  assert.equal(decide(c, mkReq('anything')), 'allowed-once')
  assert.equal(decide(c, mkReq('')), 'allowed-once')
})

test('off 全转人工', () => {
  const c = { ...defaultConfig(), mode: 'off' }
  assert.equal(decide(c, mkReq('read')), 'ask')
})

test('allowlist 命中批、未命中转人工', () => {
  const c = { ...defaultConfig(), mode: 'allowlist', allowlist: ['calendar_add', 'reset_handoff'] }
  assert.equal(decide(c, mkReq('calendar_add')), 'allowed-once')
  assert.equal(decide(c, mkReq('reset_handoff')), 'allowed-once')
  assert.equal(decide(c, mkReq('bash')), 'ask')
})

test('未知 mode 保守转人工', () => {
  const c = { ...defaultConfig(), mode: 'weird' }
  assert.equal(decide(c, mkReq('read')), 'ask')
})

test('makeAuditEntry 记录关键字段', () => {
  const e = makeAuditEntry({ req: mkReq('bash', '重载配置', 'call_x'), decision: 'allowed-once', sessionId: 's1' })
  assert.equal(e.toolName, 'bash')
  assert.equal(e.reason, '重载配置')
  assert.equal(e.callId, 'call_x')
  assert.equal(e.decision, 'allowed-once')
  assert.equal(e.sessionId, 's1')
  assert.ok(e.ts)
})

test('hermes 模式：白名单直接批，其余交 Hermes', () => {
  const c = { ...defaultConfig(), mode: 'hermes', allowlist: ['calendar_add'], denyAlways: ['bash'] }
  assert.equal(decide(c, mkReq('bash')), 'rejected')           // 黑名单优先
  assert.equal(decide(c, mkReq('calendar_add')), 'allowed-once') // 白名单直接批
  assert.equal(decide(c, mkReq('web_search')), 'hermes')         // 其余交 Hermes
  assert.equal(decide(c, mkReq('edit')), 'hermes')
})

test('parseHermesVerdict 解析各种输出', () => {
  assert.deepEqual(parseHermesVerdict('{"decision":"allowed-once","reason":"常规操作"}'), { ok: true, decision: 'allowed-once', reason: '常规操作' })
  assert.deepEqual(parseHermesVerdict('```json\n{"decision":"rejected","reason":"危险"}\n```'), { ok: true, decision: 'rejected', reason: '危险' })
  assert.equal(parseHermesVerdict('no json').ok, false)
  assert.equal(parseHermesVerdict('{"decision":"maybe"}').ok, false)
})

test('rejectReason 优先 denyReasons 配置', () => {
  const c = { ...defaultConfig(), denyReasons: { bash: '含 rm -rf 危险模式，请改安全写法' } }
  assert.equal(rejectReason(c, mkReq('bash')), '含 rm -rf 危险模式，请改安全写法')
  assert.ok(rejectReason(c, mkReq('other')).includes('denyAlways'))
})

test('buildHermesPrompt 含工具与原因', () => {
  const c = { ...defaultConfig(), mode: 'hermes' }
  const p = buildHermesPrompt(c, mkReq('bash', '重载服务'))
  assert.ok(p.includes('bash'))
  assert.ok(p.includes('重载服务'))
  assert.ok(p.includes('allowed-once'))
})

test('buildQnaPrompt 包含问题与选项', () => {
  const c = defaultConfig()
  const questions = [{ id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }]
  const p = buildQnaPrompt(c, questions, '会话上下文: 测试')
  assert.ok(p.includes('q1'))
  assert.ok(p.includes('选哪个？'))
  assert.ok(p.includes('1. A'))
  assert.ok(p.includes('会话上下文: 测试'))
})

test('parseQnaVerdict 解析序号/标签/自由文本', () => {
  const questions = [
    { id: 'q1', question: '选哪个？', options: [{ label: '方案A' }, { label: '方案B' }] },
    { id: 'q2', question: '自由回答？', options: [] },
  ]
  const a1 = parseQnaVerdict('q1: 2\nq2: 自定义内容', questions)
  assert.equal(a1[0].id, 'q1')
  assert.deepEqual(a1[0].selected, ['方案B'])
  assert.equal(a1[1].id, 'q2')
  assert.deepEqual(a1[1].selected, ['自定义内容'])
  // 未回答补空
  const a2 = parseQnaVerdict('q1: 1', questions)
  assert.deepEqual(a2[1].selected, [])
  // 空输入
  assert.deepEqual(parseQnaVerdict('', questions)[1].selected, [])
})

test('parseHermesVerdict 解析带 Hermes 装饰框的真实输出', () => {
  const raw = '╭─ ⚕ Hermes ───────────────────────╮\n{"decision":"rejected","reason":"理由过于空泛，请补充目标文件与目的"}\n╰──────────────────────────────────╯\nResume this session with: hermes --resume xxx'
  const r = parseHermesVerdict(raw)
  assert.equal(r.ok, true)
  assert.equal(r.decision, 'rejected')
  assert.ok(r.reason.includes('空泛'))
})

test('parseHermesVerdict 解析 reason 含引号/括号的 JSON', () => {
  const raw = '日志行 {\"x\":1} {"decision":"allowed-once","reason":"常规（安全）操作，已检查"}'
  const r = parseHermesVerdict(raw)
  assert.equal(r.ok, true)
  assert.equal(r.decision, 'allowed-once')
  assert.ok(r.reason.includes('常规'))
})

test('parseHermesVerdict 死循环防护：索引0+非法枚举 不挂起', () => {
  const r = parseHermesVerdict('{"decision":"maybe"}')
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('无合法裁决'))
})

test('parseHermesVerdict 死循环防护：索引0+未闭合 JSON 不挂起', () => {
  const r = parseHermesVerdict('{"decision":"allowed-once","reason":"未闭合')
  assert.equal(r.ok, false)
})

test('parseHermesVerdict 死循环防护：空/无 decision 不挂起', () => {
  assert.equal(parseHermesVerdict('').ok, false)
  assert.equal(parseHermesVerdict('no json here').ok, false)
})
