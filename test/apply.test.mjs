import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, Config, liveConfig, name } from '../lib/index.js';

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
  const effects = [];
  const ctx = {
    on: () => {},
    effect: (fn, desc) => { effects.push(String(desc ?? '')); return fn(); },
    root: { get: () => undefined },
    tools: { register: () => {} },
  };
  apply(ctx, { scheduleRetryEnabled: 0 });
  assert.equal(effects.filter((d) => d.includes('retry timer')).length, 0);
});

test('默认装重试心跳', () => {
  const effects = [];
  const ctx = {
    on: () => {},
    effect: (fn, desc) => { effects.push(String(desc ?? '')); return fn(); },
    root: { get: () => undefined },
    tools: { register: () => {} },
  };
  apply(ctx, { scheduleRetryIntervalSec: 5 });
  assert.equal(effects.filter((d) => d.includes('retry timer')).length, 1);
});

test('liveConfig：改原配置字段后读到新值（设置页立即生效）', () => {
  const raw = { repeatGuardEchoMin: 2 };
  const cfg = liveConfig(raw);
  assert.equal(cfg.repeatGuardEchoMin, 2);
  raw.repeatGuardEchoMin = 5;
  assert.equal(cfg.repeatGuardEchoMin, 5);
});
