/**
 * dsh-mmy-knight：安静骑士。
 * 两件事——① 拦住模型的复读打转；② 调度器投递失败时自动重试。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Config, name } from './config.js';
import { registerRepeatGuard, repeatGuardStats } from './repeat.js';
import { registerScheduleRetry } from './schedule-retry.js';

export { Config, name };
export { repeatGuardStats };

function cacheDirOf(cfg) {
  if (cfg?.cacheDir) return String(cfg.cacheDir);
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  return join(home, 'cache');
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

export function apply(ctx, config) {
  const cfg = config ?? {};
  const log = makeLogger(cfg);
  log('apply 进入');
  registerRepeatGuard(ctx, cfg);
  registerScheduleRetry(ctx, cfg, log);
  log('已注册：复读拦截 + 调度器重试');
}
