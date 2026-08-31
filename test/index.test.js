import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultConfig, validateConfig, decide, makeAuditEntry } from '../src/policy.js'

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
