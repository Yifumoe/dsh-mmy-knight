# dsh-mmy-knight

DSH 的「安静骑士」：拦住模型复读打转，顺手把调度器的投递失败捞回来。

两件事，一个插件：

| 模块 | 干什么 |
| --- | --- |
| 复读拦截 | 挂在 `llm/stream` 上实时看思考段（可选正文），发现碎嘴短句、整段重复、句子复读、原地打转、工具调用重复就打住，经 `agent/turn-stopping` 推一条带证据的续跑指令；连续熔断会先静默冷却，再不行就转强制交接 |
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
| `repeatGuardEnabled` | 1 | 总开关 |
| `repeatGuardEchoMin` | 2 | 碎嘴短句连续几次算复读（单字项固定 3 次） |
| `repeatGuardParaMin` | 3 | 整段重复：连续几行全等 |
| `repeatGuardSentMin` | 3 | 句子复读：同一句出现几次 |
| `repeatGuardLoopMin` | 4 | 原地打转：短行重复多少次 |
| `repeatGuardShortRepeat` | 5 | 口头禅：同一极短句出现几次 |
| `repeatGuardBody` | 0 | 也查正文（默认只查思考段，防误伤表格与清单） |
| `repeatGuardFuse` | 3 | 熔断窗口内最多拦几次 |
| `repeatGuardFuseWindow` | 15 | 熔断统计窗口（分钟） |
| `repeatGuardCooldownMin` | 10 | 熔断后静默冷却（分钟） |
| `repeatGuardMaxRecoveries` | 1 | 熔断后自动恢复几次 |
| `repeatGuardHandoff` | 0 | 恢复后仍熔断就强制交接（默认关：开了会新建会话） |
| `repeatGuardFold` | 0 | 退化步折叠（默认关） |
| `repeatGuardFoldDryRun` | 1 | 折叠先只观察 |
| `repeatGuardFoldMinChars` | 300 | 折叠：思考段最短多少字才处理 |
| `repeatGuardToolLoop` | 3 | 工具调用重复：同参数重复几次算打转 |
| `repeatGuardToolWindow` | 20 | 工具调用重复：看最近多少步 |

### 调度器重试

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `scheduleRetryEnabled` | 1 | 总开关 |
| `scheduleRetryIntervalSec` | 60 | 心跳间隔（秒，最小 5） |

### 公共

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `cacheDir` | `$DSH_HOME/cache` | 日志与状态目录 |

日志：`<cacheDir>/repeat-guard.jsonl`（每次命中一行）、`<cacheDir>/mmy-knight.log`（加载与诊断）。

## 开发

```bash
npm test          # 判据单测（5 例）
node --check lib/index.js
```

测试需要在本地有 `@deepseek-ai/dsh-llm` 与 `@deepseek-ai/schemastery`（peer 依赖）。

## 已知边界

- 判据是启发式的：宁可漏判，不误伤清单与代码块
- 熔断后强制交接**默认关闭**：它会写 `memory/交接.md` 并调 `mmy_new_chat` 新建会话，对「记住你」这件事是反效果；需要时再显式设 `repeatGuardHandoff: 1`
- 调度器重试依赖 `ctx.root.get('schedule')`；宿主没有 schedule 服务时静默跳过

## License

MIT
