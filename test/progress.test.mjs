import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PROGRESS_STEPS,
  lastStepWasSilent,
  pickProgressNudge,
  registerProgressNudge,
} from '../lib/progress.js';

/** 造一个最小 agent：surface.nodes 是事件 id 列表，eventAt 按 id 取事件。 */
function makeAgent(events) {
  return {
    session: {
      surface: { nodes: events.map((_, index) => index) },
      eventAt: (id) => events[id],
    },
  };
}

test('pickProgressNudge：返回池内文本，且带「不要复述本句」', () => {
  for (let i = 0; i < 20; i += 1) {
    const text = pickProgressNudge();
    assert.equal(typeof text, 'string');
    assert.ok(text.startsWith('（过程纪律提醒）'), `应带标记：${text}`);
    assert.ok(text.includes('不要复述本句'), `应带防复读约束：${text}`);
  }
});

test('lastStepWasSilent：最近一条 assistant 只有工具调用 = 沉默', () => {
  const agent = makeAgent([
    { type: 'user/message' },
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
  ]);
  assert.equal(lastStepWasSilent(agent), true);
});

test('lastStepWasSilent：最近一条 assistant 有正文 = 说过话', () => {
  const agent = makeAgent([
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '说了一句' }] } } },
  ]);
  assert.equal(lastStepWasSilent(agent), false);
});

test('lastStepWasSilent：空 text 块不算说过话', () => {
  const agent = makeAgent([
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '   ' }] } } },
  ]);
  assert.equal(lastStepWasSilent(agent), true);
});

test('lastStepWasSilent：碰到 user/message 就停，不算沉默', () => {
  const agent = makeAgent([
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
    { type: 'user/message' },
  ]);
  assert.equal(lastStepWasSilent(agent), false);
});

test('lastStepWasSilent：没有 surface 时返回 false', () => {
  assert.equal(lastStepWasSilent({}), false);
  assert.equal(lastStepWasSilent(undefined), false);
});

test('registerProgressNudge：默认 0 = 关，不注入', async () => {
  assert.equal(DEFAULT_PROGRESS_STEPS, 0);
  const handlers = [];
  const ctx = { on: (evt, fn) => handlers.push({ evt, fn }) };
  registerProgressNudge(ctx, { progressNudgeSteps: 0 });
  const handler = handlers.find((h) => h.evt === 'agent/pre-step').fn;
  const agent = makeAgent([
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
  ]);
  const decision = { kind: 'enter', messages: [] };
  const out = await handler({ agent, step: 5 }, async () => decision);
  assert.equal(out.messages.length, 0);
});

test('registerProgressNudge：连续两步沉默后注入一条', async () => {
  const handlers = [];
  const ctx = { on: (evt, fn) => handlers.push({ evt, fn }) };
  registerProgressNudge(ctx, { progressNudgeSteps: 2 });
  const handler = handlers.find((h) => h.evt === 'agent/pre-step').fn;
  const agent = makeAgent([
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
  ]);
  const next = async () => ({ kind: 'enter', messages: [] });

  const first = await handler({ agent, step: 2 }, next);
  assert.equal(first.messages.length, 0, '第一步沉默只计数，不注入');
  const second = await handler({ agent, step: 3 }, next);
  assert.equal(second.messages.length, 1, '第二步沉默应注入');
  assert.ok(String(second.messages[0].content?.[0]?.text ?? '').includes('过程纪律提醒'));
});

test('registerProgressNudge：说过话就清零计数', async () => {
  const handlers = [];
  const ctx = { on: (evt, fn) => handlers.push({ evt, fn }) };
  registerProgressNudge(ctx, { progressNudgeSteps: 2 });
  const handler = handlers.find((h) => h.evt === 'agent/pre-step').fn;
  const next = async () => ({ kind: 'enter', messages: [] });

  // 同一个 session 对象（WeakMap 按对象记计数），只换 surface 里的事件内容。
  const silentEvent = {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'tool-call' }] } },
  };
  const spokeEvent = {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '说了' }] } },
  };
  let current = silentEvent;
  const session = {
    surface: { nodes: [0] },
    eventAt: () => current,
  };
  const agent = { session };

  await handler({ agent, step: 2 }, next); // 沉默 1 次
  current = spokeEvent;
  await handler({ agent, step: 3 }, next); // 说过话 → 清零
  current = silentEvent;
  const again = await handler({ agent, step: 4 }, next);
  assert.equal(again.messages.length, 0, '清零后重新计数，不应立刻注入');
});

test('registerProgressNudge：decision 不是 enter 时不动', async () => {
  const handlers = [];
  const ctx = { on: (evt, fn) => handlers.push({ evt, fn }) };
  registerProgressNudge(ctx, { progressNudgeSteps: 1 });
  const handler = handlers.find((h) => h.evt === 'agent/pre-step').fn;
  const agent = makeAgent([
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
  ]);
  const decision = { kind: 'skip' };
  const out = await handler({ agent, step: 5 }, async () => decision);
  assert.equal(out, decision);
});
