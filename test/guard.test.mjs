import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  analyzeRepeat,
  checkFuse,
  createTurnStoppingGuard,
  decideFuseAction,
  fingerprint,
  guardStream,
  logHit,
  probeWithTimeout,
  repeatGuardStats,
  stripCode,
  sweepDegenerate,
  sweepToolLoop,
} from '../lib/repeat.js';
import { registerScheduleRetry } from '../lib/schedule-retry.js';

const BASE = { echoMin: 2, paraMin: 3, sentMin: 3, loopMin: 4, shortRepeatMin: 5 };

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'knight-test-'));
}

function fullCfg(overrides = {}) {
  return {
    enabled: true,
    echoMin: 2,
    paraMin: 3,
    sentMin: 3,
    loopMin: 4,
    shortRepeatMin: 5,
    fuse: 3,
    fuseWindowMin: 15,
    cooldownMin: 10,
    maxRecoveries: 1,
    handoffOnFuse: false,
    bodyGuard: false,
    fold: false,
    foldDryRun: true,
    foldMinChars: 300,
    toolLoopMin: 3,
    toolWindow: 20,
    cacheDir: tempDir(),
    ...overrides,
  };
}

function newState() {
  return {
    pending: new Map(),
    fuse: new Map(),
    lastSteerAt: new Map(),
    recovery: new Map(),
    escalated: new Map(),
    foldSeen: new WeakMap(),
    toolSeen: new WeakMap(),
    toolNoticed: new Map(),
  };
}

async function* fromList(list) {
  for (const item of list) yield item;
}

test('checkFuse：窗口内超过 fuse 次进入冷却，冷却结束重新给满额', () => {
  const state = { fuse: new Map() };
  const cfg = { fuse: 2, fuseWindowMin: 15, cooldownMin: 10 };
  const t0 = 1_000_000;
  assert.equal(checkFuse(state, 's1', cfg, t0).action, 'block');
  assert.equal(checkFuse(state, 's1', cfg, t0 + 1000).action, 'block');
  const third = checkFuse(state, 's1', cfg, t0 + 2000);
  assert.equal(third.action, 'pass');
  assert.equal(third.reason, 'fuse');
  assert.equal(checkFuse(state, 's1', cfg, t0 + 3000).reason, 'cooldown');
  // 冷却结束后 count 归零，重新可以拦（冷却从第三次命中时刻起算）。
  assert.equal(checkFuse(state, 's1', cfg, t0 + 2000 + 10 * 60000 + 1).action, 'block');
});

test('decideFuseAction：恢复 → 交接 → 耗尽，冷却期只冷却', () => {
  const state = { recovery: new Map() };
  const cfg = { maxRecoveries: 1, handoffOnFuse: true };
  const hit = { kind: 'echo', evidence: '写。', count: 2 };
  assert.equal(decideFuseAction(state, 's1', cfg, hit, { reason: 'fuse' }).mode, 'recovery');
  assert.equal(decideFuseAction(state, 's1', cfg, hit, { reason: 'fuse' }).mode, 'handoff');
  assert.equal(decideFuseAction(state, 's1', cfg, hit, { reason: 'fuse' }).mode, 'exhausted');
  assert.equal(decideFuseAction(state, 's1', cfg, hit, { reason: 'cooldown' }).mode, 'cooldown');
});

test('guardStream：思考段复读会补 block-end + finish(stop)', async () => {
  const cfg = fullCfg();
  const state = newState();
  const big = '写。\n'.repeat(300); // 900 字，过 600 字检测门槛
  const out = [];
  for await (const chunk of guardStream(
    fromList([
      { type: 'reasoning-delta', text: big, index: 0 },
      { type: 'reasoning-delta', text: '继续。', index: 0 },
    ]),
    's1',
    state,
    () => cfg,
  )) {
    out.push(chunk);
  }
  assert.ok(out.some((c) => c.type === 'finish' && c.reason?.kind === 'stop'), '应截断');
  assert.ok(out.some((c) => c.type === 'block-end'), '应补 block-end');
  assert.ok(state.pending.has('s1'), '应留下续跑标记');
  rmSync(cfg.cacheDir, { recursive: true, force: true });
});

test('guardStream：没有 sessionId 时只截断、不写 pending（防串台）', async () => {
  const cfg = fullCfg();
  const state = newState();
  const big = '写。\n'.repeat(300);
  const out = [];
  for await (const chunk of guardStream(
    fromList([
      { type: 'reasoning-delta', text: big, index: 0 },
      { type: 'reasoning-delta', text: '继续。', index: 0 },
    ]),
    undefined,
    state,
    () => cfg,
  )) {
    out.push(chunk);
  }
  assert.ok(out.some((c) => c.type === 'finish'));
  assert.equal(state.pending.size, 0, '无 sessionId 不应写 pending');
  rmSync(cfg.cacheDir, { recursive: true, force: true });
});

test('schedule-retry：心跳到点会调 requestDrive', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const ctx = {
    root: { get: () => ({ runtime: { requestDrive: () => { calls += 1; } } }) },
    effect: () => {},
  };
  const timer = registerScheduleRetry(ctx, { scheduleRetryIntervalSec: 5 });
  mock.timers.tick(5000);
  assert.equal(calls, 1);
  clearInterval(timer);
  mock.timers.reset();
});

test('schedule-retry：服务不存在时不空转调用', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const ctx = { root: { get: () => undefined }, effect: () => {} };
  const timer = registerScheduleRetry(ctx, { scheduleRetryIntervalSec: 5 });
  mock.timers.tick(5000);
  assert.equal(calls, 0);
  clearInterval(timer);
  mock.timers.reset();
});

test('折叠：命中退化思考时用 replace 遮蔽 assistant 步', () => {
  const cfg = fullCfg({ fold: true, foldDryRun: false });
  const state = newState();
  const seq = 1;
  const reasoning = '写。\n'.repeat(200);
  const event = { type: 'assistant/message', surfaceOp: 'append' };
  const message = { content: [{ type: 'reasoning', text: reasoning }] };
  const appended = [];
  const session = {
    id: 's1',
    surface: { nodes: [seq] },
    eventAt: (s) => (s === seq ? event : undefined),
    deriveEventMessage: () => message,
    append: (...args) => appended.push(args),
  };
  sweepDegenerate(session, cfg, state);
  assert.equal(appended.length, 1, '应折叠一次');
  const [type, , opts] = appended[0];
  assert.equal(type, 'user/message');
  assert.equal(opts.surfaceOp.op, 'replace');
  assert.deepEqual(opts.sourceEventSeqs, [seq]);
  rmSync(cfg.cacheDir, { recursive: true, force: true });
});

test('工具循环：同参数重复 3 次追加一条提示', () => {
  const cfg = fullCfg();
  const state = newState();
  const appended = [];
  const events = new Map();
  for (const seq of [1, 2, 3]) events.set(seq, { type: 'assistant/message' });
  const session = {
    id: 's1',
    surface: { nodes: [1, 2, 3] },
    eventAt: (s) => events.get(s),
    deriveEventMessage: () => ({ content: [{ type: 'tool-call', name: 'read', arguments: '{"a":1}' }] }),
    append: (...args) => appended.push(args),
  };
  sweepToolLoop(session, cfg, state);
  assert.equal(appended.length, 1, '应提示一次');
  assert.equal(appended[0][2].surfaceOp, 'append');
  rmSync(cfg.cacheDir, { recursive: true, force: true });
});

test('日志脱敏：evidence 里的密钥落盘前被抹掉', () => {
  const cfg = fullCfg();
  logHit(cfg, { sessionId: 's1', kind: 'echo', evidence: 'sk-abcdefgh12345678 Bearer abcdefgh12345678' });
  const text = readFileSync(join(cfg.cacheDir, 'repeat-guard.jsonl'), 'utf8');
  assert.ok(!text.includes('sk-abcdefgh12345678'), 'sk- 密钥应被抹掉');
  assert.ok(!text.includes('Bearer abcdefgh12345678'), 'Bearer token 应被抹掉');
  rmSync(cfg.cacheDir, { recursive: true, force: true });
});

test('stripCode：4 空格缩进的正常文本不再被整行删掉', () => {
  const text = '    写。\n    写。\n';
  assert.ok(stripCode(text).includes('写。'), '缩进文本应保留');
  assert.ok(stripCode('    const a = 1;\n').trim() === '', '缩进代码仍应剔除');
});

test('echo：不同短句连续出现不再累加', () => {
  assert.equal(analyzeRepeat('好。\n收到。\n好的。', BASE), null);
  assert.ok(analyzeRepeat('好。\n好。', BASE), '同一句连续仍应命中');
});

test('A/B 交替：6 行短窗口也能命中', () => {
  const hit = analyzeRepeat(['A。', 'B。', 'A。', 'B。', 'A。', 'B。'].join('\n'), BASE);
  assert.ok(hit, '应命中');
  assert.equal(hit.kind, 'loop');
});

test('turn-stopping：无 sessionId 直接返回，不消费 no-session 的 pending', () => {
  const state = newState();
  state.pending.set('no-session', { kind: 'echo', evidence: '写。', count: 2 });
  const guard = createTurnStoppingGuard(state, () => fullCfg());
  guard({ agent: {} });
  assert.ok(state.pending.has('no-session'), '不应消费共享 key');
});

test('repeatGuardStats：不传 sessionId 只给聚合，不列明细', () => {
  const dir = tempDir();
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, 'repeat-guard.jsonl'),
    [
      JSON.stringify({ at: now, sessionId: 'sess-A', kind: 'echo', evidence: 'A 的片段', count: 2 }),
      JSON.stringify({ at: now, sessionId: 'sess-B', kind: 'echo', evidence: 'B 的片段', count: 3 }),
    ].join('\n') + '\n',
  );
  const out = repeatGuardStats({ cacheDir: dir }, { days: 1 });
  assert.ok(out.includes('未指定会话'), '应提示只给聚合');
  assert.ok(!out.includes('A 的片段') && !out.includes('B 的片段'), '不应出现任何会话明细');
  rmSync(dir, { recursive: true, force: true });
});

test('repeatGuardStats：传 sessionId 只统计该会话', () => {
  const dir = tempDir();
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, 'repeat-guard.jsonl'),
    [
      JSON.stringify({ at: now, sessionId: 'sess-A', kind: 'echo', evidence: 'A 的片段', count: 2 }),
      JSON.stringify({ at: now, sessionId: 'sess-B', kind: 'echo', evidence: 'B 的片段', count: 3 }),
    ].join('\n') + '\n',
  );
  const out = repeatGuardStats({ cacheDir: dir }, { days: 1, sessionId: 'sess-A' });
  assert.ok(out.includes('A 的片段'), '应含 A 的明细');
  assert.ok(!out.includes('B 的片段'), '不应含 B 的明细');
  rmSync(dir, { recursive: true, force: true });
});

test('fingerprint：同参数稳定、不同参数不同', () => {
  assert.equal(fingerprint('{"a":1}'), fingerprint('{"a":1}'));
  assert.notEqual(fingerprint('{"a":1}'), fingerprint('{"a":2}'));
  assert.equal(fingerprint('{"a":1}').length, 12);
});

test('guardStream：正文截断时 probe 到的 tool-call 不丢（GPT 审查）', async () => {
  const cfg = fullCfg({ bodyGuard: true });
  const state = newState();
  const line = '这是一句会被判复读的话。\n';
  const out = [];
  for await (const chunk of guardStream(
    fromList([
      { type: 'text-delta', text: line, index: 0 },
      { type: 'text-delta', text: line, index: 0 },
      { type: 'text-delta', text: line, index: 0 },
      { type: 'tool-call', name: 'read', index: 0 },
    ]),
    's1',
    state,
    () => cfg,
  )) {
    out.push(chunk);
  }
  assert.ok(out.some((c) => c.type === 'finish' && c.reason?.kind === 'stop'), '应截断');
  assert.ok(out.some((c) => c.type === 'tool-call'), 'probe 到的 tool-call 应被转发，不能丢');
  rmSync(cfg.cacheDir, { recursive: true, force: true });
});

test('probeWithTimeout：超时后迟到的 step 交给 onLate，不丢（GPT 审查）', async () => {
  let late = null;
  const iterator = {
    next: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ done: false, value: { type: 'text-delta', text: '迟到' } }), 60),
      ),
  };
  const probe = await probeWithTimeout(iterator, 10, (step) => {
    late = step;
  });
  assert.equal(probe, null, '超时应返回 null');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(late?.value?.text, '迟到', '迟到的 step 应交给 onLate');
});
