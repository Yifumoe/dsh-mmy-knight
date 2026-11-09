/**
 * dsh-mmy-knight 的配置：复读拦截 + 调度器投递重试。
 * 字段名沿用 `repeatGuard*`（从 dsh-mmy-tools 迁过来时不用改配置）。
 */
import Schema from '@deepseek-ai/schemastery';

export const name = 'dsh-mmy-knight';

export const Config = Schema.object({
  // —— 复读拦截 ——
  repeatGuardEnabled: Schema.natural().default(0).description('总开关（1 开 / 0 关）').volatile(),
  repeatGuardEchoMin: Schema.natural().default(2).description('碎嘴短句连续几次算复读').volatile(),
  repeatGuardParaMin: Schema.natural().default(3).description('整段重复：连续几行全等').volatile(),
  repeatGuardSentMin: Schema.natural().default(5).description('句子复读：同一句出现几次').volatile(),
  repeatGuardLoopMin: Schema.natural().default(4).description('原地打转：短行重复多少次算复读').volatile(),
  repeatGuardBody: Schema.natural().default(1).description('也查正文（1 开 / 0 关；正文重复是真实事故，默认开）').volatile(),
  repeatGuardShortRepeat: Schema.natural().default(8).description('口头禅：同一极短句出现几次算打转').volatile(),
  repeatGuardNudgeRun: Schema.natural().default(3).description('系统提醒复读：连续几行含提醒标记算复读').volatile(),
  repeatGuardFuse: Schema.natural().default(2).description('熔断窗口内最多拦几次').volatile(),
  repeatGuardFuseWindow: Schema.natural().default(15).description('熔断统计窗口（分钟）').volatile(),
  repeatGuardCooldownMin: Schema.natural().default(10).description('熔断后静默冷却（分钟）').volatile(),
  repeatGuardMaxRecoveries: Schema.natural().default(1).description('熔断后自动恢复几次').volatile(),
  repeatGuardHandoff: Schema.natural().default(1).description('恢复后仍熔断就强制交接（1 开 / 0 关；默认开，开了会新建会话）').volatile(),
  repeatGuardFold: Schema.natural().default(0).description('退化步折叠（1 开 / 0 关）').volatile(),
  repeatGuardFoldDryRun: Schema.natural().default(1).description('折叠先只观察（1 = 只记日志）').volatile(),
  repeatGuardFoldMinChars: Schema.natural().default(300).description('折叠：思考段最短多少字才处理').volatile(),
  repeatGuardToolLoop: Schema.natural().default(3).description('工具调用重复：同参数重复几次算打转').volatile(),
  repeatGuardToolWindow: Schema.natural().default(20).description('工具调用重复：看最近多少步').volatile(),

  // —— 过程纪律 ——
  progressNudgeSteps: Schema.natural().default(0).description('连续几步「只调工具没说话」就催一次正文（0 = 关；建议 3~5，1 = 每步都催太吵；2026-11-09 从 mmy-life 迁来，默认关）').volatile(),

  // —— 思考语言 ——
  thinkingLangGuard: Schema.natural().default(1).description('思考语言守卫（1 开 / 0 关；每轮注入中文约束 + 检测英文思考）').volatile(),
  thinkingLangStyle: Schema.natural().default(1).description('每轮注入交流习惯（语音播报 / 表情包 / 重启方式；1 开 / 0 关）').volatile(),
  thinkingLangStrict: Schema.natural().default(1).description('检测到英文思考就强制中文重来（1 开 / 0 关；会多花一次生成的 token）').volatile(),

  // —— 调度器投递重试 ——
  scheduleRetryEnabled: Schema.natural().default(1).description('投递失败自动重试（1 开 / 0 关）').volatile(),
  scheduleRetryIntervalSec: Schema.natural().default(60).description('重试心跳间隔（秒，最小 5）').volatile(),

  // —— 公共 ——
  cacheDir: Schema.string().default('').description('日志与状态目录，留空 = DSH_HOME/cache').volatile(),
});
