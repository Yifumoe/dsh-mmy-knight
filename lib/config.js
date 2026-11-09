/**
 * dsh-mmy-knight 的配置：复读拦截 + 调度器投递重试。
 * 字段名沿用 `repeatGuard*`（从 dsh-mmy-tools 迁过来时不用改配置）。
 */
import Schema from '@deepseek-ai/schemastery';

export const name = 'dsh-mmy-knight';

export const Config = Schema.object({
  // —— 复读拦截 ——
  repeatGuardEnabled: Schema.natural().default(0).description('总开关（1 开 / 0 关）'),
  repeatGuardEchoMin: Schema.natural().default(2).description('碎嘴短句连续几次算复读'),
  repeatGuardParaMin: Schema.natural().default(3).description('整段重复：连续几行全等'),
  repeatGuardSentMin: Schema.natural().default(5).description('句子复读：同一句出现几次'),
  repeatGuardLoopMin: Schema.natural().default(4).description('原地打转：短行重复多少次算复读'),
  repeatGuardBody: Schema.natural().default(1).description('也查正文（1 开 / 0 关；正文重复是真实事故，默认开）'),
  repeatGuardShortRepeat: Schema.natural().default(8).description('口头禅：同一极短句出现几次算打转'),
  repeatGuardNudgeRun: Schema.natural().default(3).description('系统提醒复读：连续几行含提醒标记算复读'),
  repeatGuardFuse: Schema.natural().default(2).description('熔断窗口内最多拦几次'),
  repeatGuardFuseWindow: Schema.natural().default(15).description('熔断统计窗口（分钟）'),
  repeatGuardCooldownMin: Schema.natural().default(10).description('熔断后静默冷却（分钟）'),
  repeatGuardMaxRecoveries: Schema.natural().default(1).description('熔断后自动恢复几次'),
  repeatGuardHandoff: Schema.natural().default(1).description('恢复后仍熔断就强制交接（1 开 / 0 关；默认开，开了会新建会话）'),
  repeatGuardFold: Schema.natural().default(0).description('退化步折叠（1 开 / 0 关）'),
  repeatGuardFoldDryRun: Schema.natural().default(1).description('折叠先只观察（1 = 只记日志）'),
  repeatGuardFoldMinChars: Schema.natural().default(300).description('折叠：思考段最短多少字才处理'),
  repeatGuardToolLoop: Schema.natural().default(3).description('工具调用重复：同参数重复几次算打转'),
  repeatGuardToolWindow: Schema.natural().default(20).description('工具调用重复：看最近多少步'),

  // —— 过程纪律 ——
  progressNudgeSteps: Schema.natural().default(0).description('连续几步「只调工具没说话」就催一次正文（0 = 关；2026-11-09 从 mmy-life 迁来，默认关）'),

  // —— 调度器投递重试 ——
  scheduleRetryEnabled: Schema.natural().default(1).description('投递失败自动重试（1 开 / 0 关）'),
  scheduleRetryIntervalSec: Schema.natural().default(60).description('重试心跳间隔（秒，最小 5）'),

  // —— 公共 ——
  cacheDir: Schema.string().default('').description('日志与状态目录，留空 = DSH_HOME/cache'),
});
