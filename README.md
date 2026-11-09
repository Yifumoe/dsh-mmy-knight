# dsh-mmy-knight

DSH 的「小伊的守护骑士」：拦住模型复读打转、催它别闷头干活、盯住思考语言，顺手把调度器的投递失败捞回来。

四件事，一个插件：

| 模块 | 干什么 |
| --- | --- |
| 复读拦截 | 挂在 `llm/stream` 上实时看思考段（可选正文），发现碎嘴短句、整段重复、句子复读、原地打转、工具调用重复就打住，经 `agent/turn-stopping` 推一条带证据的续跑指令；连续熔断会先静默冷却，再不行就转强制交接 |
| 过程纪律 | 挂在 `agent/pre-step` 上，连续 N 步「只调工具没说话」就注入一条提醒，催模型用正文通报进度（默认关，`progressNudgeSteps` 调） |
| 思考语言 | 每轮注入中文思考约束；流式检测思考段里的英文，strict 模式经 `agent/turn-stopping` 推「用中文重来」 |
| 调度器重试 | `dsh-schedule` 在「到点任务全失败」时不再排下一次 timer，任务会永久休眠；每 60 秒调一次 `requestDrive()` 让它重新扫描 |

## 安装

```bash
dsh plugin --profile desktop add file:<本仓库绝对路径>
```

或者从源码目录（复制安装，最稳）：

```bash
cd dsh-mmy-knight
dsh plugin --profile desktop add file:$(pwd)
```

装完重启 DSH。

## 配置

全部字段都有默认值，装完即用。想调就在设置页改，或者写进 `cordis.patch.yml`：

```yaml
- id: dsh-mmy-knight
  config:
    repeatGuardEnabled: 1
    repeatGuardEchoMin: 2
    scheduleRetryIntervalSec: 60
```

### 复读拦截

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `repeatGuardEnabled` | 0 | 总开关（1 开 / 0 关） |
| `repeatGuardEchoMin` | 2 | 碎嘴短句连续几次算复读（单字项固定 3 次） |
| `repeatGuardParaMin` | 3 | 整段重复：连续几行全等 |
| `repeatGuardSentMin` | 5 | 句子复读：同一句出现几次（窗口 40 句，去重率 ≤50% 才算循环） |
| `repeatGuardLoopMin` | 4 | 原地打转：短行重复多少次 |
| `repeatGuardShortRepeat` | 8 | 口头禅：同一极短句出现几次 |
| `repeatGuardBody` | 1 | 也查正文（默认开；正文重复是真实事故） |
| `repeatGuardNudgeRun` | 3 | 系统提醒复读：连续几行含提醒标记算复读 |
| `repeatGuardFuse` | 2 | 熔断窗口内最多拦几次 |
| `repeatGuardFuseWindow` | 15 | 熔断统计窗口（分钟） |
| `repeatGuardCooldownMin` | 10 | 熔断后静默冷却（分钟） |
| `repeatGuardMaxRecoveries` | 1 | 熔断后自动恢复几次 |
| `repeatGuardHandoff` | 1 | 恢复后仍熔断就强制交接（默认开，开了会新建会话） |
| `repeatGuardFold` | 0 | 退化步折叠（默认关） |
| `repeatGuardFoldDryRun` | 1 | 折叠先只观察 |
| `repeatGuardFoldMinChars` | 300 | 折叠：思考段最短多少字才处理 |
| `repeatGuardToolLoop` | 3 | 工具调用重复：同参数重复几次算打转 |
| `repeatGuardToolWindow` | 20 | 工具调用重复：看最近多少步 |

### 过程纪律

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `progressNudgeSteps` | 0 | 连续几步「只调工具没说话」就催一次正文（0 = 关） |

话术池 10 条随机挑，避免连续重复；每条以「（过程纪律提醒）」开头、以「不要复述本句。」结尾，防止被复读判据当成正文复读。

### 思考语言

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `thinkingLangGuard` | 1 | 思考语言守卫（1 开 / 0 关；每轮注入中文约束 + 检测英文思考） |
| `thinkingLangStrict` | 1 | 检测到英文思考就强制中文重来（1 开 / 0 关；会多花一次生成的 token） |

### 调度器重试

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `scheduleRetryEnabled` | 1 | 总开关 |
| `scheduleRetryIntervalSec` | 60 | 心跳间隔（秒，最小 5） |

### 公共

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `cacheDir` | `$DSH_HOME/cache` | 日志与状态目录 |

日志：`<cacheDir>/repeat-guard.jsonl`（每次命中一行）、`<cacheDir>/mmy-knight.log`（加载与诊断）、`<cacheDir>/thinking-lang.log`（思考语言检测）。宿主侧的 `startup-catchup` 与 `mmy_repeat_guard` 会同时读工作区 `.cache` 和 `$DSH_HOME/cache`，默认配置下两边都能看到。

## 开发

```bash
npm test          # 判据 / 熔断 / 流截断 / 折叠 / 工具循环 / 过程纪律 / 调度重试（45 例）
node --check lib/index.js
```

测试需要在本地有 `@deepseek-ai/dsh-llm` 与 `@deepseek-ai/schemastery`（peer 依赖）。

## 已知边界

- 判据是启发式的：宁可漏判，不误伤清单与代码块
- 句子复读判据看「窗口内同一句出现次数 + 去重率」：4 种说法循环时窗口 40 句里每种 10 次，稳过门槛；正常长文本同一句偶尔出现 5 次不会被误伤
- 熔断后强制交接**默认开启**：它会写 `memory/交接.md` 并调 `mmy_new_chat` 新建会话；不想要就设 `repeatGuardHandoff: 0`
- 过程纪律默认关：注入成 user message 会被模型当正文引用，nudge 判据再把它当复读截断，形成死循环（2026-11-09 实测注入 546 次把输出切碎）
- 调度器重试依赖 `ctx.root.get('schedule')`；宿主没有 schedule 服务时静默跳过

## License

MIT
