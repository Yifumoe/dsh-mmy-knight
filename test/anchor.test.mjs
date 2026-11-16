import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTION_REMINDER, registerThinkingLang } from '../lib/thinking.js';

/** 最小 ctx：只收集事件回调。 */
function makeCtx() {
  const handlers = new Map();
  return {
    handlers,
    on(name, fn) {
      handlers.set(name, fn);
    },
  };
}

async function runPreStep(ctx, sessionId, turn) {
  const handler = ctx.handlers.get('agent/pre-step');
  const payload = { agent: { session: { id: sessionId } }, turn };
  const decision = { kind: 'enter', messages: [] };
  return handler(payload, async () => decision);
}

test('每轮注入行动锚：默认开启，语言 + 交流 + 行动三条', async () => {
  const ctx = makeCtx();
  registerThinkingLang(ctx, { thinkingLangGuard: 1, thinkingLangStyle: 1, actionAnchor: 1 });
  const out = await runPreStep(ctx, 'anchor-s1', 1);
  const texts = out.messages.map((m) => m.content?.[0]?.text ?? '');
  assert.ok(texts.includes(ACTION_REMINDER), '应注入行动锚原文');
  assert.ok(ACTION_REMINDER.startsWith('［每轮重申·行动］'));
  assert.equal(out.messages.length, 3, '语言 + 交流 + 行动三条');
});

test('行动锚可单独关闭：关掉后只剩两条', async () => {
  const ctx = makeCtx();
  registerThinkingLang(ctx, { thinkingLangGuard: 1, thinkingLangStyle: 1, actionAnchor: 0 });
  const out = await runPreStep(ctx, 'anchor-s2', 1);
  const texts = out.messages.map((m) => m.content?.[0]?.text ?? '');
  assert.equal(texts.some((t) => t.includes('每轮重申·行动')), false);
  assert.equal(out.messages.length, 2);
});

test('行动锚不含复读原词（防 priming）', () => {
  for (const word of ['继续', '让我', '先念']) {
    assert.equal(ACTION_REMINDER.includes(word), false, `不该出现：${word}`);
  }
});
