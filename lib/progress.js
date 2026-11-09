/**
 * 过程纪律：连续多少个「只有工具调用、没有正文」的步骤后催一次。
 *
 * 2026-11-09 从 `mmy-life/lib/thinking-lang.js` 迁来（主人要求：过程纪律归 knight，
 * 和复读拦截放一起，设置页也在那边）。
 *
 * 为什么不能注入成普通 user message 就完事：
 *   注入的提醒会被模型当正文引用，复读判据再把它当「系统提醒复读」截断，形成死循环。
 *   所以这里做三件事：
 *   1. 话术池随机出，避免同一句反复注入被当成复读；
 *   2. 文本自带「不要复述本句」的约束；
 *   3. 默认 0（关）——2026-11-09 实测注入 546 次把输出切碎，先关着，要开在设置页调。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** 连续多少个「只有工具调用、没有正文」的步骤后催一次（0 = 关）。 */
export const DEFAULT_PROGRESS_STEPS = 0;

/** 催报提醒话术池。抄自 dsh-progress-rules 的判据，措辞按我们的口吻收短。 */
const PROGRESS_NUDGES = [
  '（过程纪律提醒）上一步只执行了工具、没有输出正文。现在先用 1–3 句正文向用户说明：' +
    '刚做了什么、得出了什么结论、下一步做什么；然后再继续。不要复述本句。',
  '（过程纪律提醒）这一步只有工具调用，正文还空着。先用两三句话讲清楚刚才做了什么、' +
    '看到什么结果、接下来打算怎么办，再继续。不要复述本句。',
  '（过程纪律提醒）先跟主人说一句再往下走：当前进展、判断依据、下一步动作，简短就好。不要复述本句。',
  '（过程纪律提醒）工具跑完了，但还没说话。补一两句给人看的说明，然后接着做。不要复述本句。',
  '（过程纪律提醒）别闷头干活。用一小段正文交代现在到哪一步、为什么要这么做。不要复述本句。',
  '（过程纪律提醒）这一步只看到工具调用。先说清楚你在查什么、为什么查，再继续。不要复述本句。',
  '（过程纪律提醒）主人还等着看进展。用一两句话概括刚拿到的结果，然后往下走。不要复述本句。',
  '（过程纪律提醒）先输出正文再调用下一个工具：现在做到哪、结论是什么、下一步打算。不要复述本句。',
  '（过程纪律提醒）这一轮还没有正文。简要汇报当前状态与判断，别让对话空着。不要复述本句。',
  '（过程纪律提醒）停一下，把手上这一步的结论写出来，再决定下一步动作。不要复述本句。',
];

/** 从话术池里随机挑一条（避免同一句反复注入被当成复读）。 */
export function pickProgressNudge() {
  return PROGRESS_NUDGES[Math.floor(Math.random() * PROGRESS_NUDGES.length)];
}

/**
 * 上一步是不是「只调工具、没说话」。
 * 从会话 surface 倒着找最近的 assistant/message：有非空 text 块 = 说过话；
 * 碰到 user/message 或 turn/start = 本轮还没轮到它说，不算沉默。
 * @param {object} agent
 * @returns {boolean}
 */
export function lastStepWasSilent(agent) {
  const session = agent?.session;
  const surface = session?.surface;
  if (surface === undefined || !Array.isArray(surface.nodes)) return false;
  for (let index = surface.nodes.length - 1; index >= 0; index -= 1) {
    const event = session.eventAt(surface.nodes[index]);
    if (event === undefined) continue;
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content;
      if (!Array.isArray(content)) return false;
      return !content.some(
        (block) => block?.type === 'text' && String(block.text ?? '').trim() !== '',
      );
    }
    if (event.type === 'user/message' || event.type === 'turn/start') return false;
  }
  return false;
}

/**
 * 装配入口：由 lib/index.js 的 apply 调用。
 * @param {object} ctx cordis 上下文
 * @param {object} cfg 解引用后的配置代理（每次读都是最新值）
 */
export function registerProgressNudge(ctx, cfg) {
  /** session 对象 -> 连续沉默步数（WeakMap：会话对象回收后自动清）。 */
  const silent = new WeakMap();

  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const decision = await next();
      try {
        const steps = Math.max(0, Math.trunc(Number(cfg.progressNudgeSteps ?? DEFAULT_PROGRESS_STEPS)));
        if (steps <= 0) return decision;
        if (decision?.kind !== 'enter') return decision;
        const agent = payload?.agent;
        const session = agent?.session;
        const step = Number(payload?.step ?? 0);
        if (session === undefined || step <= 1) return decision;

        if (!lastStepWasSilent(agent)) {
          silent.set(session, 0);
          return decision;
        }
        const run = (silent.get(session) ?? 0) + 1;
        if (run < steps) {
          silent.set(session, run);
          return decision;
        }
        silent.set(session, 0);
        const messages = Array.isArray(decision.messages) ? [...decision.messages] : [];
        messages.push(
          createUserMessage({
            content: [{ type: 'text', text: pickProgressNudge() }],
            source: {
              kind: 'plugin:dsh-mmy-knight',
              form: 'notice',
              summary: '过程纪律：要求正文通报',
            },
          }),
        );
        return { ...decision, messages };
      } catch {
        // 注入失败绝不能拖垮这一步
        return decision;
      }
    },
    { global: true },
  );
}
