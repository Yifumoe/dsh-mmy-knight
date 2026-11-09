/**
 * dsh-mmy-knight：安静骑士。
 * 两件事——① 拦住模型的复读打转；② 调度器投递失败时自动重试。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { defineTool } from '@deepseek-ai/dsh-tools';

import { Config, name } from './config.js';
import { registerProgressNudge } from './progress.js';
import { defaultCacheDir, registerRepeatGuard, repeatGuardStats } from './repeat.js';
import { registerScheduleRetry } from './schedule-retry.js';
import { registerThinkingLang } from './thinking.js';

export { Config, name };
export { repeatGuardStats };

/** cordis 服务声明：registerStatsTool 要访问 ctx.tools，不声明会在加载时抛
 *  `cannot get property "tools" without inject`（可选链挡不住 Proxy）。 */
export const inject = ['tools'];

function cacheDirOf(cfg) {
  if (cfg?.cacheDir) return String(cfg.cacheDir);
  // 与 repeat.js 共用同一个默认目录，别再各算各的（P2）。
  return defaultCacheDir();
}

/** schemastery 的 volatile 字段是 ref，读的时候要解引用。 */
function liveValue(field) {
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') return field.get();
  return field;
}

/** 把配置包成「读取时解引用」的代理：设置页改完立即生效，不用重启。 */
export function liveConfig(config) {
  const raw = config || {};
  const read = (key) => liveValue(raw[key]);
  return new Proxy({}, {
    get(_t, key) {
      if (typeof key === 'symbol') return undefined;
      if (key === 'toJSON') {
        const out = {};
        for (const k of Object.keys(raw)) out[k] = read(k);
        return out;
      }
      return read(key);
    },
    has: (_t, key) => key in raw,
    ownKeys: () => Reflect.ownKeys(raw),
    getOwnPropertyDescriptor(_t, key) {
      return { configurable: true, enumerable: true, writable: false, value: read(key) };
    },
  });
}

function makeLogger(cfg) {
  const file = join(cacheDirOf(cfg), 'mmy-knight.log');
  return (msg) => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
    } catch {
      /* 诊断日志失败不能影响插件加载 */
    }
  };
}

/** 把 repeatGuardStats 注册成只读工具（以前只导出、没注册，等于白写；P2）。 */
function registerStatsTool(ctx, cfg) {
  if (typeof ctx?.tools?.register !== 'function') return;
  try {
    ctx.tools.register(
      defineTool({
        name: 'knight_repeat_stats',
        description: '读 dsh-mmy-knight 的复读拦截日志，返回最近 N 天的命中摘要（只读，不改任何状态）。',
        parameters: {
          days: { type: 'number', description: '回看几天，默认 1' },
          sessionId: {
            type: 'string',
            description: '只统计该会话；不传只给聚合计数（跨会话调用看不到别的会话明细）',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
        },
        async execute({ days, sessionId }) {
          return repeatGuardStats(cfg, {
            days: Number(days) || 1,
            sessionId: sessionId ? String(sessionId) : undefined,
          });
        },
      }),
    );
  } catch {
    /* 宿主没有工具注册能力时跳过，不影响拦截本身 */
  }
}

export function apply(ctx, config) {
  const cfg = liveConfig(config);
  const log = makeLogger(cfg);
  log('apply 进入');
  // 排查用：cordis 注入的 config 到底有没有读到 cordis.patch.yml 的值。
  log(`配置快照: enabled=${cfg.repeatGuardEnabled} body=${cfg.repeatGuardBody} sentMin=${cfg.repeatGuardSentMin} shortRepeat=${cfg.repeatGuardShortRepeat}`);
  registerRepeatGuard(ctx, cfg);
  registerProgressNudge(ctx, cfg);
  registerThinkingLang(ctx, cfg);
  registerScheduleRetry(ctx, cfg, log);
  registerStatsTool(ctx, cfg);
  log('已注册：复读拦截 + 过程纪律 + 思考语言 + 调度器重试 + 统计工具');
}
