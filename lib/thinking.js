/**
 * 思考语言守卫（2026-11-07 从 mmy-life 迁入 dsh-mmy-knight，2026-11-09 主人要求合并）。
 *
 * 主人原话「思考又变成英文了，我们需要什么才能固定中文思考？写进 AGENTS 和记忆库没有用」。
 *
 * 为什么 AGENTS / 记忆库不管用：
 *   那两条都是一次性的静态上下文，位置在长历史的最前面。上下文一长，模型的思考语言
 *   会被最近的英文内容（工具输出、代码、日志、报错）带跑；每 token 采样只看最近几千字。
 *   所以「写一次就指望它一直生效」在机制上不成立。
 *
 * 这一版用两个宿主级杠杆：
 *   1. `agent/pre-step`（waterfall）：**每一轮**在进入模型的最后一条消息后面追加一句
 *      语言约束。位置最靠后 = 影响力最大，而且不靠模型记性。
 *   2. `llm/stream`：统计 reasoning-delta 的中英比例，命中「英文思考」就记
 *      `.cache/thinking-lang.log`；strict 模式下由 `agent/turn-stopping` 用
 *      `agent.steer(...)` 推一条「用简体中文重新推理」，掐断重来（复用复读拦截
 *      已经验证过的通道）。
 *
 * 边界（诚实说明）：
 *   - 这不是 100% 硬锁。宿主不允许改写冻结的请求体（LOOP 请求 deep-frozen），
 *     所以只能靠「每轮注入 + 检测纠正」，不能像改参数那样强制。
 *   - strict 模式会多花一次生成的 token；默认只对「整段英文思考」触发，且每会话
 *     10 分钟最多纠正一次，避免烧钱。
 *   - 判定前会剥掉代码块/行内代码/路径，避免把「读日志时的英文」当成英文思考。
 */

import fs from 'node:fs';
import { join } from 'node:path';

import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** 每轮注入的语言约束。短、具体、可执行，别写成道德劝说。 */
const LANG_REMINDER =
  '［每轮重申·语言］你的推理过程（thinking / reasoning）必须用简体中文书写——' +
  '工具输出、代码、日志、报错里的英文不影响这条约束，读英文材料，用中文推理。';

/** 每轮注入的交流习惯（语音 / 表情 / 重启），与语言约束分开开关。 */
const STYLE_REMINDER =
  '［每轮重申·交流］①思考过程中的关键节点都要用 mmy_say 出声播报，别闷头干活。' +
  '②正文回复先念朗读版再打字，并尽量配一张表情包（sticker_send 当轮返回的链接，别复用旧的）。' +
  '③重启 DSH 只用 mmy_restart（GUI 重启、官方重启、手动杀进程都不会往会话里排消息）。';

const STRICT_STEER =
  '［语言纠正］刚才这一步的推理写成了英文。请改用简体中文重新推理，然后继续未完成的任务；' +
  '已经做完的部分不用重做。';

/** 判定阈值：去掉代码后至少这么多字符才判，避免短思考误伤。 */
const MIN_CHARS = 200;
/** 拉丁字母至少这么多，才算「真的在用英文写」。 */
const MIN_LATIN = 150;
/** 中文字符占比低于这个值，判为英文思考。 */
const MAX_CJK_RATIO = 0.05;
/** 同一会话两次强制纠正的最小间隔。 */
const STEER_INTERVAL_MS = 10 * 60 * 1000;

/** 去掉围栏代码块、行内代码、反引号路径，剩下的才算「思考文本」。 */
export function stripCodeForLang(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\b[A-Za-z]:\\[^\s，。；、）)】]+/g, ' ')
    .replace(/\/[A-Za-z0-9._\-/]{3,}/g, ' ');
}

/** 返回 { cjk, latin, chars, english } —— english 为 true 表示判为英文思考。 */
export function classifyThinking(text) {
  const s = stripCodeForLang(text);
  const cjk = (s.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (s.match(/[A-Za-z]/g) ?? []).length;
  const chars = cjk + latin;
  const english = chars >= MIN_CHARS && latin >= MIN_LATIN && cjk / Math.max(1, chars) < MAX_CJK_RATIO;
  return { cjk, latin, chars, english };
}

function appendLog(cfg, entry) {
  try {
    const dir = cfg.cacheDir || '.cache';
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(join(dir, 'thinking-lang.log'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    /* 日志写不进去不影响功能 */
  }
}

/** Map 只留最近 N 个会话，防止长跑进程里无限增长。 */
function pruneMap(map, max = 200) {
  if (!map || map.size <= max) return map;
  const drop = map.size - max;
  let i = 0;
  for (const key of map.keys()) {
    map.delete(key);
    if (++i >= drop) break;
  }
  return map;
}

/**
 * 装配入口。
 * @param {object} ctx 插件上下文
 * @param {object} cfg 解引用后的配置代理
 */
export function registerThinkingLang(ctx, cfg) {
  const readConfig = () => ({
    enabled: Number(cfg.thinkingLangGuard ?? 1) !== 0,
    style: Number(cfg.thinkingLangStyle ?? 1) !== 0,
    strict: Number(cfg.thinkingLangStrict ?? 1) !== 0,
    cacheDir: cfg.cacheDir || '.cache',
  });

  /** 每会话状态：本轮是否已注入、最近一次纠正时间、本轮是否已判为英文。 */
  const state = {
    turn: new Map(), // sessionId -> turn
    flagged: new Map(), // sessionId -> true
    lastSteer: new Map(), // sessionId -> ts
  };

  // 1) 每轮注入中文约束（过程纪律已迁到 dsh-mmy-knight/lib/progress.js，2026-11-09）。
  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const decision = await next();
      try {
        const opts = readConfig();
        if (!opts.enabled || decision?.kind !== 'enter') return decision;
        const agent = payload?.agent;
        const session = agent?.session;
        const sessionId = session?.id ?? 'no-session';
        const turn = Number(payload?.turn ?? 0);
        const messages = Array.isArray(decision.messages) ? [...decision.messages] : [];
        let changed = false;

        // a) 每轮一次：语言约束 + 交流习惯，各自独立开关
        if (state.turn.get(sessionId) !== turn) {
          state.turn.set(sessionId, turn);
          pruneMap(state.turn);
          state.flagged.delete(sessionId);
          if (opts.enabled) {
            messages.push(
              createUserMessage({
                content: [{ type: 'text', text: LANG_REMINDER }],
                source: { kind: 'plugin:dsh-mmy-knight', form: 'notice', summary: '每轮中文思考约束' },
              }),
            );
            changed = true;
          }
          if (opts.style) {
            messages.push(
              createUserMessage({
                content: [{ type: 'text', text: STYLE_REMINDER }],
                source: { kind: 'plugin:dsh-mmy-knight', form: 'notice', summary: '每轮交流习惯' },
              }),
            );
            changed = true;
          }
        }

        return changed ? { ...decision, messages } : decision;
      } catch {
        // 注入失败绝不能拖垮这一步
        return decision;
      }
    },
    { global: true },
  );

  // 2) 流式检测：只看 reasoning-delta，不改流、不掐断（strict 的掐断交给 turn-stopping）。
  ctx.on(
    'llm/stream',
    (options, next) => {
      const opts = readConfig();
      if (!opts.enabled || options?.purpose !== undefined) return next();
      const sessionId = options?.sessionId ?? 'no-session';
      return guardStream(next(), sessionId, opts, state);
    },
    { global: true },
  );

  // 3) 轮末纠正：strict 模式下把「英文思考」变成一条中文重来的指令。
  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const opts = readConfig();
      if (!opts.enabled || !opts.strict) return;
      const sessionId = payload?.agent?.session?.id ?? 'no-session';
      if (!state.flagged.get(sessionId)) return;
      const now = Date.now();
      if (now - (state.lastSteer.get(sessionId) ?? 0) < STEER_INTERVAL_MS) return;
      state.lastSteer.set(sessionId, now);
      pruneMap(state.lastSteer);
      state.flagged.delete(sessionId);
      appendLog(opts, { sessionId, action: 'steer' });
      payload.agent.steer(
        createUserMessage({
          content: [{ type: 'text', text: STRICT_STEER }],
          source: { kind: 'plugin:dsh-mmy-knight', form: 'notice', summary: '思考语言纠正' },
        }),
      );
    } catch (error) {
      appendLog(readConfig(), { action: 'steer-error', error: String(error) });
    }
  });

  try {
    console.log('[mmy-knight] 思考语言守卫已装备（每轮注入 + 英文思考检测/纠正）');
  } catch {
    /* stdout 不可用不影响功能 */
  }
}

/** 包一层流：累计 reasoning，判定英文思考后打标记 + 记日志，不改动上游输出。 */
async function* guardStream(downstream, sessionId, opts, state) {
  let thought = '';
  let nextCheckAt = MIN_CHARS;
  for await (const chunk of downstream) {
    if (chunk?.type === 'reasoning-delta') {
      thought += chunk.text ?? '';
      // 边涨边判：模型可能前段中文、后段切英文，只判一次会漏。
      if (thought.length >= nextCheckAt) {
        nextCheckAt = thought.length + 200;
        const verdict = classifyThinking(thought);
        if (verdict.english && !state.flagged.get(sessionId)) {
          state.flagged.set(sessionId, true);
          pruneMap(state.flagged);
          appendLog(opts, { sessionId, action: 'detected', ...verdict });
        }
      }
    }
    yield chunk;
  }
}
