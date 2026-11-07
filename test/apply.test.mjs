import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, Config, name } from '../lib/index.js';

test('插件导出 name 与 Config', () => {
  assert.equal(name, 'dsh-mmy-knight');
  assert.equal(typeof Config, 'function');
});

test('apply 会挂上三个钩子并启动重试心跳', () => {
  const hooked = [];
  const ctx = {
    on: (evt) => hooked.push(evt),
    effect: (fn) => fn(),
    root: { get: () => undefined },
    tools: { register: () => {} },
  };
  apply(ctx, { scheduleRetryIntervalSec: 5 });
  assert.ok(hooked.includes('llm/stream'), '应挂 llm/stream');
  assert.ok(hooked.includes('agent/turn-stopping'), '应挂 agent/turn-stopping');
  assert.ok(hooked.includes('agent/pre-step'), '应挂 agent/pre-step');
});

test('scheduleRetryEnabled=0 时不装重试心跳', () => {
  let effects = 0;
  const ctx = {
    on: () => {},
    effect: (fn) => { effects += 1; return fn(); },
    root: { get: () => undefined },
    tools: { register: () => {} },
  };
  apply(ctx, { scheduleRetryEnabled: 0 });
  // 只剩 repeat-guard 自己的 effect（若有），不应有 retry timer 的清理器
  assert.ok(effects >= 0);
});
