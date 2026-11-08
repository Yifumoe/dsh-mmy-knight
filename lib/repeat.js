/**
 * 复读退化拦截（鲸鱼娘自研，2026-10-30 替代上游 dsh-repeat-guard 0.3.3）。
 *
 * 挂两处：
 *   1. `llm/stream`：包一层上游流，检测思考段（reasoning-delta）里的复读退化。命中就补
 *      block-end + finish(stop) 掐断本次生成；提前 return 时必须显式向下游 iterator.return，
 *      否则上游 HTTP 流会继续跑到结束，供应商照常计满 token。
 *   2. `agent/turn-stopping`：本轮边界提交前，若有没续跑的标记，用 `agent.steer(...)` 推一条
 *      带证据的输入，让本轮再跑一步，而不是停下来等用户说话。
 *
 * 与上游 0.3.3 的差别（判据 1 类 → 3 类，且每条命中都能指出证据）：
 *   - echo：整行与短句表全等；单字项（写。查。看。做。）要连续出现 ≥3 次才算，
 *     因为列清单时它们独占一行是正常的，上游把它们当普通表项、阈值 1，误伤就是这么来的。
 *   - para：连续 N 行完全相同（整段抄三遍，上游完全不管，这才是真正烧钱的那类）。
 *   - sent：同一句在最近 20 句窗口里出现 ≥ N 次（句子级复读）。
 *   - 正文检测默认关（上游也不查正文）：正文复读比思考段少见，且拦错代价更高。
 *
 * 命中后写 `.cache/repeat-guard.jsonl`。
 *
 * 2026-10-31 二修（主人原话「卡复读之后你就直接不动了，先彻底解决复读」）：
 * 上一版把熔断计数放在 turn-stopping 里清零，本意是「每轮重新给满额」，
 * 结果 `agent/turn-stopping` 在**每次掐断后**都会触发 —— 计数永远是 0，
 * fuse 一次也没生效，会话陷入「拦 → steer → 再复读 → 再拦」的死循环。
 * 这一版改成与轮次无关的**时间窗口熔断**：窗口内（默认 15 分钟）累计命中超过
 * fuse 次，就进入冷却（默认 10 分钟）期间只放行不拦截。宁可让模型把复读写完，
 * 也不能让会话卡死。另外两处配套：
 *   - steer 每会话 5 分钟最多一次（反复 steer 就是反复请求，比复读更贵）；
 *   - 掐断时把复读尾巴挡在 block-end 之外，别把垃圾喂回上下文让它越学越歪。
 *
 * 2026-11-03 三修（事故：session-3046 熔断后一路复读到只能提前交接会话）：
 * 二修的「冷却期只放行」是错的——放行不等于恢复。日志里 18:06 熔断后到 18:13
 * 有 200+ 条 cooldown 放行，模型持续输出「跑。」「执行。」，用户只能交接。
 * 这一版把熔断的语义从「放行」改成「只截断、不 steer」：命中照旧掐断本次生成，
 * 但不再推续跑指令。不 steer 就不会有「拦→steer→再复读」的循环，熔断的初衷
 * （别把会话卡死）仍然成立；而截断保证复读不会一路烧到冷却结束。
 *
 * 2026-11-03 四修（主人拍板「先做半自动，再测全自动」）：
 * 三修只截断不 steer，会话确实不烧了，但也没有下一步——长任务只能等主人
 * 手动说「继续」。这一版给熔断加恢复梯度：
 *   第一次熔断（reason='fuse'）→ steer 一条恢复提示，让模型换表达继续；
 *   第二次熔断（已恢复过一次）→ steer 强制交接指令（写 memory/交接.md + mmy_new_chat）；
 *   第三次熔断 → 只截断，写 .cache/repeat-guard-escalate.json，交给 startup-catchup 报警；
 *   冷却期内（reason='cooldown'）→ 只截断，不恢复、不交接、不累计次数。
 * 半自动边界：mmy_new_chat 建的是空白会话，建完要主人说一句「继续」；
 * 全自动（交接指令直接带 seed 建会话）等这一版上线验证过再说。
 */

import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';

/** 缓存目录：DSH_HOME/cache 或 ~/.dsh/cache（不写死工作区路径） */
export function defaultCacheDir() {
  const home = process.env.DSH_HOME || (os.homedir ? os.homedir() + '/.dsh' : '.dsh');
  return String(home).replace(/\\/g, '/') + '/cache';
}
import { join } from 'node:path';

import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** 普通短句表：整行全等、连续 echoMin 次算命中。标点照原样写。 */
const ECHO_LINES = [
  '好。',
  '好的。',
  '好嘞。',
  '对的。',
  '是的。',
  '可以的。',
  '明白了。',
  '收到。',
  '了解。',
  '执行。',
  '继续。',
  '确认。',
  '完成。',
  '搞定。',
  'ok.',
  'okay.',
  'sure.',
  'alright.',
  'right.',
  'yes.',
  'done.',
  'got it.',
  'let me go.',
  'let me do it.',
  'check it.',
];

/** 单字项：单独出现是正常的（列清单），连续 3 次以上才当复读。 */
const SINGLE_LINES = ['写。', '查。', '看。', '做。', '对。', '是。', '行。', '嗯。'];

const ECHO_SET = new Set(ECHO_LINES.map((line) => line.toLowerCase()));
const SINGLE_SET = new Set(SINGLE_LINES.map((line) => line.toLowerCase()));

/** 系统注入的提醒文本标记：模型把它当正文复读时，出现 2 次就判复读（2026-11-08 事故）。 */
const NUDGE_MARK = '（过程纪律提醒）';

/** 只看尾部窗口：思考段再长，复读也发生在最近这些行里。避免每 chunk 全量重扫。 */
const WINDOW_LINES = 80;
const WINDOW_CHARS = 6000;
/** 句子级判定只看最近这么多句。 */
const SENT_WINDOW = 20;
/** 太短的句子不算（「好的」两字太容易撞）。 */
const SENT_MIN_LEN = 8;
/**
 * 长程低差异循环的窗口与短行门槛。
 * 2026-10-31 事故复盘：反复的是「做。」「好。」「做，好。」「（输出）做，好。好。」这种
 * **每行都略微不同**的短句，前三类判据（整行全等 / 连续计数 / 8 字以上同句）全部漏掉。
 * 所以这一类的判据不看「相等」，看「窗口内短行占比高 + 重复度高」。
 */
const LOOP_WINDOW = 40;
const LOOP_SHORT = 12;

/**
 * 工具调用重复：同一工具 + 同一组参数在最近 N 个 assistant 步里出现 ≥ M 次。
 * 第六类判据（2026-10-31 从上游 #9121「技能无限循环」议题里挖出来的缺口：
 * 我们原先只拦文本复读，拦不住「同一技能一轮调无数次」）。
 * 只追加一条提示，不阻断、不改工具结果。
 */
const TOOL_WINDOW_DEFAULT = 20;
const TOOL_LOOP_MIN = 3;
/**
 * 等待类工具：反复调用是正常行为（一次等满 5 分钟、超时后再等），不计入重复。
 * 2026-10-31 用真实会话日志预演时唯一误报就是它。名字可能带 MCP 前缀
 * （`mcp__snowluma__qq_wait_for_messages`），所以按后缀匹配。
 */
const TOOL_LOOP_EXEMPT = [/qq_wait_for_messages$/];
function isToolExempt(name) {
  return TOOL_LOOP_EXEMPT.some((pattern) => pattern.test(name));
}

/**
 * 像代码/标记的行：写 HTML、写脚本时同一片段重复出现是正常的（`</div>` 连三行、
 * `<section class="band">` 在多个块里出现），不该按「复读」处理。命中这类行时
 * 把门槛放大 CODE_FACTOR 倍，只有在真死循环（重复十几次）时才拦。
 */
const CODEISH =
  /[<>{}]|=>|\(\s*\)|;\s*$|^\s*(?:const|let|var|import|export|function|return|if|for|while|yield|await|console\.)\b/i;
const CODE_FACTOR = 3;
function isCodeish(line) {
  return CODEISH.test(line);
}

/** 单字项连续出现多少次才算复读。 */
const SINGLE_RUN = 3;

/**
 * 纯应答词：正常对话、记笔记、列方案时天然高频，不作为复读证据。
 * 2026-10-31 实测：没有这张表时，我自己的思考段里每 40 行出现 5 次「好。」
 * 就被掐断，越掐越卡（误伤比漏判贵得多）。
 */
const TINY_ALLOW = new Set([
  '好。', '好的。', '好吧。', '对。', '对的。', '是的。', '是。', '嗯。',
  '行。', '可以。', '收到。', '明白。', '明白。', 'ok。', 'ok.', 'okay.',
]);

/** 熔断窗口（分钟）：窗口内累计命中多少次就进入冷却。 */
const FUSE_WINDOW_MIN = 15;
/** 熔断冷却（分钟）：冷却期内只放行，不再掐断。 */
const FUSE_COOLDOWN_MIN = 10;
/** 掐断时回退掉多少行：把复读尾巴挡在上下文之外。 */
const SAFE_TRIM_LINES = LOOP_WINDOW;
/** 折叠只处理这个长度以上的 reasoning 块（太短的不值得动，也更容易误判）。 */
const FOLD_MIN_CHARS = 300;

/** steer 限流：同一会话最短提醒间隔（毫秒）。反复 steer 就是反复请求，比复读本身更贵。 */
const STEER_INTERVAL_MS = 5 * 60 * 1000;
/** 被限流的普通提示最多存留多久：超过就作废，别拿过期指令去干扰新任务。 */
const STEER_STALE_MS = 15 * 60 * 1000;

/** 取出尾部窗口文本。 */
function tailOf(text) {
  return text.length > WINDOW_CHARS ? text.slice(-WINDOW_CHARS) : text;
}

/** 按句末标点切句。分号不切：代码里 `a; b; a;` 会被切成同句，属于误伤。 */
function splitSentences(text) {
  return text
    .split(/[。！？!?\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= SENT_MIN_LEN);
}

/**
 * 剔除围栏代码块与行内代码，避免把代码里的重复语句当复读。
 * 4 空格缩进只删「像代码」的行：以前无条件删，正常段落的缩进行也被吃掉，
 * 复读文本被删光后判据永远不命中（P2）。
 */
export function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^\s{4,}\S.*$/gm, (line) => (isCodeish(line) ? '' : line));
}

/**
 * 判定一段文本有没有复读退化。
 * @param {string} text 累积的生成文本
 * @param {{echoMin:number, paraMin:number, sentMin:number}} cfg 判据参数，0 表示关掉该类
 * @returns {{kind:string, evidence:string, count:number}|null} 命中返回证据，未命中 null
 */
export function analyzeRepeat(text, cfg) {
  const lines = tailOf(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const recent = lines.slice(-WINDOW_LINES);
  if (recent.length === 0) return null;

  // 1. 碎嘴短句：同一句连续出现才算（以前不同短句也累加，「好。收到。好的。」会被误判）
  if (cfg.echoMin > 0) {
    let run = 0;
    let single = 0;
    let lastSingle = '';
    let lastEcho = '';
    for (const line of recent) {
      const low = line.toLowerCase();
      if (SINGLE_SET.has(low)) {
        single = low === lastSingle ? single + 1 : 1;
        lastSingle = low;
        run = 0;
        lastEcho = '';
        if (single >= SINGLE_RUN) return { kind: 'echo', evidence: line, count: single };
        continue;
      }
      lastSingle = '';
      if (ECHO_SET.has(low)) {
        run = low === lastEcho ? run + 1 : 1;
        lastEcho = low;
        if (run >= cfg.echoMin) return { kind: 'echo', evidence: line, count: run };
      } else {
        run = 0;
        lastEcho = '';
      }
    }
  }

  // 2. 整段复读：连续 N 行完全相同（代码/标记行门槛放大，写 HTML 时重复属正常）
  if (cfg.paraMin > 0) {
    let run = 1;
    for (let i = 1; i < recent.length; i += 1) {
      run = recent[i] === recent[i - 1] ? run + 1 : 1;
      const need = isCodeish(recent[i]) ? cfg.paraMin * CODE_FACTOR : cfg.paraMin;
      if (run >= need) {
        return { kind: 'para', evidence: recent[i].slice(0, 80), count: run };
      }
    }
  }

  // 3. 句子复读：同一句在窗口里出现 N 次（代码/标记句同理放大）
  if (cfg.sentMin > 0) {
    const seen = new Map();
    for (const sentence of splitSentences(recent.join('\n')).slice(-SENT_WINDOW)) {
      const count = (seen.get(sentence) ?? 0) + 1;
      seen.set(sentence, count);
      const need = isCodeish(sentence) ? cfg.sentMin * CODE_FACTOR : cfg.sentMin;
      if (count >= need) {
        return { kind: 'sent', evidence: sentence.slice(0, 80), count };
      }
    }
  }

  // 4. 长程低差异循环：每行都在变，但整体在原地打转（2026-10-31「做，好」事故）
  if (cfg.loopMin > 0) {
    const win = recent.slice(-LOOP_WINDOW);
    // 4a. A/B 交替：line[i] 与 line[i-2] 相同、与 line[i-1] 不同。
    //     独立门槛 6 行：以前被 4b 的「至少 20 行」挡住，短会话里的交替永远漏判（P2）。
    if (win.length >= 6) {
      let alt = 0;
      for (let i = 2; i < win.length; i += 1) {
        alt = win[i] === win[i - 2] && win[i] !== win[i - 1] ? alt + 1 : 0;
        if (alt >= cfg.loopMin) {
          return { kind: 'loop', evidence: `A/B 交替：${win[i].slice(0, 40)}`, count: alt };
        }
      }
    }
    if (win.length >= Math.ceil(LOOP_WINDOW / 2)) {
      // 4b. 短行打转：短行占多数、且内容高度雷同（去重后不到一半），再看有没有片段
      //     出现在 60% 以上的短行里。只看「出现次数」会误伤正常列表，
      //     加「去重率」这一层才能把「40 行换了 2 种说法」和「40 行各说各的」分开。
      const shorts = win.filter((line) => line.length <= LOOP_SHORT && !isCodeish(line));
      if (
        shorts.length >= Math.ceil(win.length * 0.6) &&
        new Set(shorts).size <= shorts.length * 0.5
      ) {
        const rowsByGram = new Map();
        for (const line of shorts) {
          const grams = new Set();
          for (let n = 2; n <= Math.min(4, line.length); n += 1) {
            for (let i = 0; i + n <= line.length; i += 1) grams.add(line.slice(i, i + n));
          }
          for (const gram of grams) rowsByGram.set(gram, (rowsByGram.get(gram) ?? 0) + 1);
        }
        const needRows = Math.ceil(shorts.length * 0.6);
        for (const [gram, rows] of rowsByGram) {
          if (
            rows >= needRows &&
            rows >= cfg.loopMin &&
            gram.trim().length >= 2 &&
            !/^[，。、！？；：\s]+$/.test(gram)
          ) {
            return { kind: 'loop', evidence: `短行打转「${gram}」`, count: rows };
          }
        }
      }
    }
  }

  // 4c. 夹心式口头禅：正常长句里夹着同一个极短行反复出现（2026-10-31 主人反馈
  //     「思考里没被中断，但还有很多『做』」）。4b 要求短行占 60%，可实际形态是
  //     长句中间夹「做。」「好。」，占比永远到不了门槛；而且它被困在 20 行门槛里。
  //     这里独立成块、只要 8 行，只看同一个 ≤4 字短行出现了几次——正常写作不会在
  //     40 行里把「做。」说 5 遍。
  if (cfg.shortRepeatMin > 0) {
    const tailWin = recent.slice(-LOOP_WINDOW);
    if (tailWin.length >= 8) {
      const tiny = new Map();
      for (const line of tailWin) {
        const t = line.trim();
        if (t.length < 1 || t.length > 4) continue;
        // 纯应答词不算：正常写作里「好。」「对。」本来就多，拦它只会卡住自己。
        if (TINY_ALLOW.has(t.toLowerCase())) continue;
        if (isCodeish(t)) continue;
        if (/^[，。、！？；：\s（）()【】\[\]{}"'`·…—\-\/\\|]+$/.test(t)) continue;
        tiny.set(t, (tiny.get(t) ?? 0) + 1);
      }
      for (const [t, n] of tiny) {
        if (n >= cfg.shortRepeatMin) {
          return { kind: 'loop', evidence: `口头禅「${t}」`, count: n };
        }
      }
    }
  }

  // 5. 系统提醒文本复读：模型把注入的提醒（如「（过程纪律提醒）…」）当正文反复输出。
  //    2026-11-08 事故：同一段提醒在正文里重复 28 次，bodyGuard 关着没拦住。
  const nudgeCount = recent.filter((line) => line.includes(NUDGE_MARK)).length;
  if (nudgeCount >= 2) {
    return { kind: 'nudge', evidence: `${NUDGE_MARK} ×${nudgeCount}`, count: nudgeCount };
  }

  return null;
}

/** 日志脱敏：evidence/error 里可能夹着密钥或 token，落盘前先抹掉（P2）。
 *  2026-11-08 审计补强：原规则只认 sk-/Bearer/api_key，GitHub token、AWS key、
 *  JWT、私钥、cookie、手机号、邮箱都会漏；这里按「宁可多抹」处理。 */
const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  [/\b(Bearer)\s+[A-Za-z0-9._-]{8,}/gi, '$1 ***'],
  [/\b(api[_-]?key|access[_-]?token|password|secret|passwd)\s*[:=]\s*["']?[^\s"',}]{6,}/gi, '$1=***'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, 'gh*_***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'jwt.***'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '-----PRIVATE KEY-----'],
  [/\b(cookie|set-cookie)\s*[:=]\s*[^\s;]{8,}/gi, '$1=***'],
  [/\b1[3-9]\d{9}\b/g, '1**********'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***'],
];
function redact(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text.slice(0, 200);
}

/** 参数指纹：只留短 hash，不落原文（工具参数可能来自不可信网页/群消息）。 */
export function fingerprint(value) {
  try {
    return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 12);
  } catch {
    return '????????????';
  }
}

/** 把一次拦截写进 jsonl；写不了就算了，不能因为日志失败影响主流程。 */
export function logHit(cfg, record) {
  const dir = cfg.cacheDir || defaultCacheDir();
  const file = join(dir, 'repeat-guard.jsonl');
  const safe = { ...record };
  for (const key of ['evidence', 'error', 'args']) {
    if (safe[key] !== undefined) safe[key] = redact(safe[key]);
  }
  try {
    // 日志会 7×24 追加：超过 2 MB 就滚到 .1（只留最近一卷），避免几年后撑爆缓存盘。
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
    } catch {
      /* 文件还不存在，或改名失败：直接追加 */
    }
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...safe })}\n`, 'utf8');
  } catch {
    /* 缓存目录不可写：放弃日志，不影响拦截 */
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

/** 命中类型的短标签，给注入正文用（唯一来源是下面的 KIND_LABEL）。 */
function kindLabel(kind) {
  return KIND_LABEL[kind] ?? '碎嘴短句';
}

/**
 * 掐断时回退掉尾部若干行，只把「复读开始之前」的内容交给上下文。
 * 不这么做的话，模型下一轮读到自己的复读，会继续照抄（2026-10-31 的循环就是这么养出来的）。
 */
function trimRepeated(text) {
  const lines = text.split('\n');
  if (lines.length > SAFE_TRIM_LINES) return lines.slice(0, -SAFE_TRIM_LINES).join('\n');
  // 行数不多（思考段本来就短）时按字符回退，别把正常内容一刀切光。
  return text.slice(0, Math.max(0, text.length - 400));
}

/**
 * 熔断判定：与轮次无关的时间窗口累计。
 * @param {{fuse: Map<string, {count:number, since:number, cooldownUntil:number}>}} state
 * @param {string} key 会话 key
 * @param {{fuse:number, fuseWindowMin?:number, cooldownMin?:number}} cfg
 * @param {number} now 当前毫秒（测试可注入）
 * @returns {{action:'block'|'pass', reason?:string, used?:number, until?:number}}
 */
export function checkFuse(state, key, cfg, now = Date.now()) {
  const windowMs = Math.max(1, cfg.fuseWindowMin ?? FUSE_WINDOW_MIN) * 60000;
  const cooldownMs = Math.max(1, cfg.cooldownMin ?? FUSE_COOLDOWN_MIN) * 60000;
  const rec = state.fuse.get(key) ?? { count: 0, since: now, cooldownUntil: 0 };
  if (now < rec.cooldownUntil) {
    return { action: 'pass', reason: 'cooldown', until: rec.cooldownUntil };
  }
  // 冷却刚结束：重新给满额，否则 count 会一路加，冷却形同虚设。
  if (rec.cooldownUntil && now >= rec.cooldownUntil) {
    rec.count = 0;
    rec.since = now;
    rec.cooldownUntil = 0;
  }
  if (now - rec.since > windowMs) {
    rec.count = 0;
    rec.since = now;
  }
  rec.count += 1;
  state.fuse.set(key, rec);
  if (cfg.fuse > 0 && rec.count > cfg.fuse) {
    rec.cooldownUntil = now + cooldownMs;
    return { action: 'pass', reason: 'fuse', until: rec.cooldownUntil };
  }
  return { action: 'block', used: rec.count - 1 };
}

/**
 * 熔断时刻决定下一步动作（2026-11-03 四修）。
 * 只有 reason='fuse'（刚触发熔断）才恢复/交接；reason='cooldown' 一律只截断。
 * @param {object} state 跨监听状态（用 recovery / escalated）
 * @param {string} key 会话 id
 * @param {object} cfg 现取配置
 * @param {{kind:string,evidence:string}} hit 命中详情
 * @param {{reason:string}} verdict checkFuse 的返回
 * @returns {{mode:'cooldown'|'recovery'|'handoff'|'exhausted', attempts?:number}}
 */
export function decideFuseAction(state, key, cfg, hit, verdict) {
  if (verdict.reason !== 'fuse') return { mode: 'cooldown' };
  if (!state.recovery) state.recovery = new Map();
  const now = Date.now();
  const rec = state.recovery.get(key) ?? { attempts: 0, handoff: false, lastAt: 0 };
  // 以前 attempts 是「终身计数」：同一个会话隔几天再犯，直接跳过恢复、甚至直接交接。
  // 一小时没再熔断就当作新一轮。
  if (rec.lastAt && now - rec.lastAt > 60 * 60 * 1000) {
    rec.attempts = 0;
    rec.handoff = false;
  }
  rec.lastAt = now;
  rec.attempts += 1;
  state.recovery.set(key, rec);
  pruneMap(state.recovery);
  if (rec.attempts <= cfg.maxRecoveries) return { mode: 'recovery', attempts: rec.attempts };
  if (cfg.handoffOnFuse && !rec.handoff) {
    rec.handoff = true;
    return { mode: 'handoff', attempts: rec.attempts };
  }
  return { mode: 'exhausted', attempts: rec.attempts };
}

/**
 * 第三次熔断：写升级标记，交给 startup-catchup 报「需人工交接」。
 * 每个会话只写一次（state.escalated 去重），避免一轮生成里反复落盘。
 */
function writeEscalate(cfg, entry, state) {
  const key = entry.sessionId ?? 'no-session';
  // 用 Map 而不是 Set：Set 没有淘汰机制，长跑进程里会话数只增不减（P2）。
  if (!state.escalated) state.escalated = new Map();
  if (state.escalated.has(key)) return;
  state.escalated.set(key, Date.now());
  try {
    const file = join(cfg.cacheDir || defaultCacheDir(), 'repeat-guard-escalate.json');
    let list = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      /* 首次写入或文件损坏：从空列表开始 */
    }
    list.push({ ...entry, at: new Date().toISOString() });
    if (list.length > 50) list = list.slice(-50);
    fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8');
  } catch {
    /* 写不进去不影响截断本身 */
  }
}

/**
 * 造 `llm/stream` 监听器。
 * @param {Map<string, number>} fuseCount 每个会话已拦截次数
 * @param {() => object} readConfig 现取配置（改设置立即生效）
 * @returns {(options: object, next: () => AsyncIterable<object>) => AsyncIterable<object>}
 */
export function createStreamGuard(state, readConfig) {
  return (options, next) => {
    const cfg = readConfig();
    // 辅助调用（上下文压缩、会话标题）不参与检测；总开关关掉时直接透传。
    if (!cfg.enabled || options.purpose !== undefined) return next();
    return guardStream(next(), options.sessionId, state, readConfig);
  };
}

/**
 * 探测下一格，带超时（2026-11-08 审计：原实现 `await iterator.next()` 没有超时，
 * 上游卡住时整个流会一起卡死）。超时返回 null，调用方按「不继续」处理、放行当前 chunk。
 * 注意：超时后那个 pending 的 next 仍会完成，它那一格文本会被跳过（丢一格不影响检测）。
 */
function probeWithTimeout(iterator, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ms);
    iterator.next().then(
      (step) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(step);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * 逐 chunk 包一层检测。
 * @param {AsyncIterable<object>} downstream 上游模型的流
 * @param {string|undefined} sessionId 会话 id
 * @param {{pending:Set<string>, fuse:Map<string,number>}} state 跨监听状态
 * @param {() => object} readConfig 现取配置
 */
export async function* guardStream(downstream, sessionId, state, readConfig) {
  const iterator = downstream[Symbol.asyncIterator]();
  let thought = '';
  let body = '';
  try {
    for (;;) {
      const step = await iterator.next();
      if (step.done) return;
      const chunk = step.value;

      if (chunk.type === 'reasoning-delta') {
        thought += chunk.text;
        const cfg = readConfig();
        const hit =
          (thought.length >= 600 ? analyzeRepeat(stripCode(thought), { echoMin: cfg.echoMin, paraMin: cfg.paraMin, sentMin: cfg.sentMin, loopMin: cfg.loopMin, shortRepeatMin: cfg.shortRepeatMin }) : null) ??
          (cfg.bodyGuard ? analyzeRepeat(stripCode(body), { echoMin: 0, paraMin: cfg.paraMin, sentMin: cfg.sentMin, loopMin: cfg.loopMin, shortRepeatMin: cfg.shortRepeatMin }) : null);
        if (hit) {
          // 先探一格：后面还是思考/正文在继续，才算真的在复读；若已经是工具调用或收尾，
          // 说明命中行本来就是这段的最后一句，属正常收尾，放行。探测最多等 3 秒。
          const probe = await probeWithTimeout(iterator, 3000);
          const continues =
            probe !== null && !probe.done && (probe.value.type === 'reasoning-delta' || probe.value.type === 'text-delta');
          if (continues) {
            const key = sessionId ?? 'no-session';
            const verdict = checkFuse(state, key, cfg);
            if (verdict.action === 'pass') {
              // 2026-11-03 四修：熔断后按梯度恢复（第一次恢复 / 第二次交接 / 第三次落标记）；
              // 冷却期内只截断。放行复读会让模型一路烧到冷却结束（事故：18:06→18:13）。
              const action = decideFuseAction(state, key, cfg, hit, verdict);
              // 没有 sessionId 的调用（辅助流）不写 pending：'no-session' 是共享 key，
              // 会把续跑指令串到别的会话去（P2）。
              if (sessionId && (action.mode === 'recovery' || action.mode === 'handoff')) {
                state.pending.set(key, { kind: hit.kind, evidence: hit.evidence, count: hit.count, mode: action.mode });
              } else if (action.mode === 'exhausted') {
                writeEscalate(cfg, { sessionId, attempts: action.attempts, kind: hit.kind, evidence: hit.evidence, where: 'reasoning' }, state);
              }
              logHit(cfg, { sessionId, kind: hit.kind, evidence: hit.evidence, count: hit.count, fused: true, reason: verdict.reason, recover: action.mode, until: verdict.until });
              yield chunk;
              yield { type: 'block-end', index: chunk.index, block: { type: 'reasoning', text: trimRepeated(thought) } };
              yield { type: 'finish', reason: { kind: 'stop' } };
              return;
            }
            const used = verdict.used ?? 0;
            if (sessionId) {
              state.pending.set(key, {
                kind: hit.kind,
                evidence: hit.evidence,
                count: hit.count,
              });
            }
            logHit(cfg, { sessionId, kind: hit.kind, evidence: hit.evidence, count: hit.count, fused: false, used });
            // 触发点本身已经产生，照常放行；要掐的是它之后的生成。
            yield chunk;
            yield {
              type: 'block-end',
              index: chunk.index,
              block: { type: 'reasoning', text: trimRepeated(thought) },
            };
            yield { type: 'finish', reason: { kind: 'stop' } };
            return;
          }
          yield chunk;
          if (probe !== null && !probe.done) {
            // 探出来的一格也要累加进检测窗口，否则这一块文本永远不进 thought/body，
            // 后面的复读检测会漏掉它（2026-11-06 P2）。
            if (probe.value.type === 'reasoning-delta') thought += probe.value.text;
            else if (probe.value.type === 'text-delta') body += probe.value.text;
            yield probe.value;
          }
          continue;
        }
      } else if (chunk.type === 'text-delta') {
        body += chunk.text;
        const cfg = readConfig();
        if (cfg.bodyGuard) {
          const hit = analyzeRepeat(stripCode(body), { echoMin: 0, paraMin: cfg.paraMin, sentMin: cfg.sentMin, loopMin: cfg.loopMin, shortRepeatMin: cfg.shortRepeatMin });
          if (hit) {
            const key = sessionId ?? 'no-session';
            const verdict = checkFuse(state, key, cfg);
            if (verdict.action === 'block') {
              if (sessionId) {
                state.pending.set(key, { kind: hit.kind, evidence: hit.evidence, count: hit.count, where: 'text' });
              }
              logHit(cfg, { sessionId, kind: hit.kind, evidence: hit.evidence, count: hit.count, fused: false, used: verdict.used ?? 0, where: 'text' });
              yield chunk;
              yield { type: 'block-end', index: chunk.index, block: { type: 'text', text: trimRepeated(body) } };
              yield { type: 'finish', reason: { kind: 'stop' } };
              return;
            }
            // 2026-11-03 四修：熔断同样按梯度恢复，冷却期内只截断（理由同思考段分支）。
            const action = decideFuseAction(state, key, cfg, hit, verdict);
            if (sessionId && (action.mode === 'recovery' || action.mode === 'handoff')) {
              state.pending.set(key, { kind: hit.kind, evidence: hit.evidence, count: hit.count, mode: action.mode, where: 'text' });
            } else if (action.mode === 'exhausted') {
              writeEscalate(cfg, { sessionId, attempts: action.attempts, kind: hit.kind, evidence: hit.evidence, where: 'text' }, state);
            }
            logHit(cfg, { sessionId, kind: hit.kind, evidence: hit.evidence, count: hit.count, fused: true, reason: verdict.reason, recover: action.mode, until: verdict.until, where: 'text' });
            yield chunk;
            yield { type: 'block-end', index: chunk.index, block: { type: 'text', text: trimRepeated(body) } };
            yield { type: 'finish', reason: { kind: 'stop' } };
            return;
          }
        }
      }
      yield chunk;
    }
  } finally {
    // 提前 return 时必须显式向下游传播：不补这一步上游 HTTP 流会继续跑到结束。
    try {
      await iterator.return?.();
    } catch {
      /* 上游已经结束或关闭，无需处理 */
    }
  }
}

/**
 * 造 `agent/turn-stopping` 监听器：把上一步掐断欠下的续跑补上。
 * 顺带清掉本轮的熔断计数（下一轮重新给满额）。
 * @param {{pending:Map<string,object>, fuse:Map<string,number>}} state 跨监听状态
 * @param {() => object} readConfig 现取配置
 * @returns {(payload: {agent: object}) => void}
 */
export function createTurnStoppingGuard(state, readConfig) {
  return (payload) => {
    const agent = payload?.agent;
    const sessionId = agent?.session?.id;
    // 没有会话 id 就没有可续跑的对象；用 'no-session' 兜底会把指令串到别的会话（P2）。
    if (!sessionId) return;
    const pending = state.pending.get(sessionId);
    if (!pending) return;
    state.pending.delete(sessionId);
    // 熔断计数**不清**：宿主每次掐断都会触发 turn-stopping，清了就等于永远给满额。
    // 计数由 checkFuse 按时间窗口自然衰减（FUSE_WINDOW_MIN）。
    const cfg = readConfig();
    const now = Date.now();
    const last = state.lastSteerAt.get(sessionId) ?? 0;
    // 恢复与交接提示必须发出去：它们只在熔断时出现（冷却 10 分钟起），频率天然很低；
    // 2026-11-03 实测 5 分钟限流会把 recovery 整条吃掉——熔断后模型一声不吭，恢复形同虚设。
    const urgent = pending.mode === 'recovery' || pending.mode === 'handoff';
    if (!urgent && now - last < STEER_INTERVAL_MS) {
      // 普通提示被限流时不能直接丢：先删后判会把提示静默吃掉（实测同一会话连续三次截断只发出第一条）。
      // 存回去等下一次 turn-stopping；超过 15 分钟就作废。
      const born = pending.__since ?? now;
      if (now - born < STEER_STALE_MS) {
        state.pending.set(sessionId, { ...pending, __since: born });
        logHit(cfg, { sessionId, kind: pending.kind, steer: 'suppressed', mode: pending.mode ?? 'block' });
      }
      return;
    }
    state.lastSteerAt.set(sessionId, now);
    const text = pending.mode === 'recovery'
      ? `刚才检测到${kindLabel(pending.kind)}（「${pending.evidence}」第 ${pending.count} 次），本轮已截断。` +
        '请换一种表达继续未完成的任务；如果已经完成，直接收尾。不要重复之前的句式。'
      : pending.mode === 'handoff'
        ? '本会话已连续两次因复读被截断，继续跑只会重复。请立即把当前任务状态写进 memory/交接.md' +
          '（五节：我是谁 / 干到哪 / 下一步 / 卡在哪 / 指针），旧版备份到 memory/archive/，' +
          '然后调用 mmy_new_chat 新建会话，seed 传一句「接手上一会话：先读 memory/交接.md，按『下一步』继续」。' +
          '交接完成前不要再输出复读内容。'
        : `上面${kindLabel(pending.kind)}（「${pending.evidence}」第 ${pending.count} 次）已被截断。` +
          '不要重复，直接调用工具或给出结论；同一句话再出现会被再次截断。';
    try {
      agent.steer(
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin:repeat-guard', form: 'notice', summary: '已堵住大肥鱼的嘴' },
        }),
      );
    } catch (error) {
      logHit(cfg, { sessionId, kind: pending.kind, error: String(error) });
    }
  };
}

/**
 * 装配入口：由 lib/index.js 的 apply 调用。
 * @param {object} ctx cordis 上下文
 * @param {object} cfg 解引用后的配置代理（每次读都是最新值）
 */
export function registerRepeatGuard(ctx, cfg) {
  const state = {
    pending: new Map(),
    fuse: new Map(),
    lastSteerAt: new Map(),
    recovery: new Map(),
    escalated: new Map(),
    foldSeen: new WeakMap(),
    toolSeen: new WeakMap(),
    toolNoticed: new Map(),
  };
  const readConfig = () => {
    const echoMin = Number(cfg.repeatGuardEchoMin ?? 2);
    const paraMin = Number(cfg.repeatGuardParaMin ?? 3);
    const sentMin = Number(cfg.repeatGuardSentMin ?? 3);
    const loopMin = Number(cfg.repeatGuardLoopMin ?? 4);
    const shortRepeatMin = Number(cfg.repeatGuardShortRepeat ?? 5);
    const fuse = Number(cfg.repeatGuardFuse ?? 3);
    return {
      enabled: Number(cfg.repeatGuardEnabled ?? 1) !== 0,
      echoMin: Number.isFinite(echoMin) ? echoMin : 2,
      paraMin: Number.isFinite(paraMin) ? paraMin : 3,
      sentMin: Number.isFinite(sentMin) ? sentMin : 3,
      loopMin: Number.isFinite(loopMin) ? loopMin : 4,
      shortRepeatMin: Number.isFinite(shortRepeatMin) ? shortRepeatMin : 5,
      fuse: Number.isFinite(fuse) ? fuse : 3,
      maxRecoveries: Number.isFinite(Number(cfg.repeatGuardMaxRecoveries))
        ? Math.max(0, Number(cfg.repeatGuardMaxRecoveries))
        : 1,
      handoffOnFuse: Number(cfg.repeatGuardHandoff ?? 0) !== 0,
      fuseWindowMin: Number.isFinite(Number(cfg.repeatGuardFuseWindow)) ? Number(cfg.repeatGuardFuseWindow) : FUSE_WINDOW_MIN,
      cooldownMin: Number.isFinite(Number(cfg.repeatGuardCooldownMin)) ? Number(cfg.repeatGuardCooldownMin) : FUSE_COOLDOWN_MIN,
      bodyGuard: Number(cfg.repeatGuardBody ?? 1) !== 0,
      fold: Number(cfg.repeatGuardFold ?? 0) !== 0,
      foldDryRun: Number(cfg.repeatGuardFoldDryRun ?? 1) !== 0,
      foldMinChars: Number.isFinite(Number(cfg.repeatGuardFoldMinChars)) ? Number(cfg.repeatGuardFoldMinChars) : FOLD_MIN_CHARS,
      toolLoopMin: Number.isFinite(Number(cfg.repeatGuardToolLoop)) ? Number(cfg.repeatGuardToolLoop) : TOOL_LOOP_MIN,
      toolWindow: Number.isFinite(Number(cfg.repeatGuardToolWindow))
        ? Math.max(5, Number(cfg.repeatGuardToolWindow))
        : TOOL_WINDOW_DEFAULT,
      cacheDir: cfg.cacheDir || defaultCacheDir(),
    };
  };
  ctx.on('llm/stream', createStreamGuard(state, readConfig), { global: true });
  ctx.on('agent/turn-stopping', createTurnStoppingGuard(state, readConfig));
  // 一直挂上：折叠/工具循环开关在 pre-step 里每次现读，设置页改完立即生效。
  // （以前只在启动时按配置决定挂不挂，改完必须重启才生效。）
  ctx.on('agent/pre-step', createPreStepFold(state, readConfig), { global: true });
  try {
    // 走宿主 logger，别直接 console.log 污染 stdout（P2）。
    ctx.logger?.info?.('[dsh-mmy-knight] 复读拦截已装备（五类文本判据 + 工具调用重复提示 + 退化步折叠）');
  } catch {
    /* 日志不可用不影响功能 */
  }
}

/** 命中类型的中文标签。 */
const KIND_LABEL = { echo: '碎嘴短句', para: '整段重复', sent: '句子复读', loop: '原地打转', nudge: '系统提醒复读' };

/**
 * 读拦截日志做摘要（给 mmy_repeat_guard 工具用）。
 * @param {object} cfg 解引用后的配置代理
 * @param {{days?:number}} options days = 回看几天，默认 1（今天）
 * @returns {string} 多行摘要
 */
export function repeatGuardStats(cfg, { days = 1, sessionId } = {}) {
  const file = join(cfg.cacheDir || defaultCacheDir(), 'repeat-guard.jsonl');
  let rows = [];
  try {
    rows = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return `还没有拦截记录（${file} 不存在）。拦截已装备，第一次命中就会写。`;
  }
  const since = Date.now() - Math.max(1, days) * 86400000;
  // 2026-11-08 审计：统计工具可能被跨会话调用，不按会话过滤就会读到别的会话片段。
  // 指定 sessionId 时只统计该会话；不指定时只给聚合计数，明细一律不列。
  const recent = rows.filter(
    (row) => Date.parse(row.at) >= since && (sessionId === undefined || row.sessionId === sessionId),
  );
  const byKind = new Map();
  let fused = 0;
  let folds = 0;
  let toolHits = 0;
  let toolFused = 0;
  let suppressed = 0;
  for (const row of recent) {
    if (row.fold !== undefined) {
      folds += 1;
      continue;
    }
    if (row.steer === 'suppressed') {
      // 被 5 分钟限流暂存的普通提示：既不是命中也不是截断，单独计数。
      suppressed += 1;
      continue;
    }
    if (row.tool === 'fused') {
      toolFused += 1;
      continue;
    }
    if (row.tool === 'hit') {
      toolHits += 1;
      continue;
    }
    if (row.fused) {
      fused += 1;
      continue;
    }
    const kind = row.kind || 'unknown';
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }
  const hits = recent.length - fused - folds - toolHits - toolFused - suppressed;
  const parts = [...byKind.entries()].map(([k, n]) => `${KIND_LABEL[k] ?? k} ${n}`).join(' / ') || '无';
  const lines = [
    `复读拦截：最近 ${days} 天 ${hits} 次（${parts}）｜工具循环 ${toolHits} 次｜熔断截断 ${fused + toolFused} 次｜折叠 ${folds} 次${suppressed > 0 ? `｜限流暂存 ${suppressed} 次` : ''}｜日志 ${file}`,
  ];
  if (sessionId === undefined) {
    // 不指定会话时只给聚合：跨会话调用看不到别的会话的片段。
    lines.push('（未指定会话：只给聚合计数；要看明细请传 sessionId）');
    return lines.join('\n');
  }
  for (const row of recent.slice(-5).reverse()) {
    const when = String(row.at ?? '').slice(11, 16);
    const tag = row.fold !== undefined
      ? `折叠(${row.fold})`
      : row.tool === 'hit'
        ? `工具循环(${row.name ?? '?'})`
        : row.tool === 'fused'
          ? '工具熔断'
          : row.fused
            ? '熔断截断'
            : (KIND_LABEL[row.kind] ?? row.kind ?? '?');
    const sid = row.sessionId ? ` 会话=${String(row.sessionId).slice(0, 12)}` : '';
    lines.push(`- ${when} ${tag}「${String(row.evidence ?? row.name ?? '').slice(0, 40)}」×${row.count ?? '?'}${sid}`);
  }
  return lines.join('\n');
}

/**
 * 退化步折叠（2026-10-31，思路借鉴 walksls/dsh-degeneration-kit 的 thinking-guard）。
 *
 * 掐断只止血当前这一段；已经写进会话的复读块不会消失——之后每一步它都会作为
 * assistant 的 reasoning 内容重新发给上游（`dsh-opencode-go` 构造历史时把 reasoning
 * 块映射成 `reasoning_content`，见该包 `lib/index.js` 的 assistant 消息组装），
 * 模型看见自己在复读，就更难停下来。这里把命中的那一步**连同它调起的工具结果**
 * 用一条 `user/message` 等价替换（`surfaceOp: replace`）：日志只追加、人看的记录不变，
 * 只有模型可见的 surface 里那一步变成一句说明。
 *
 * 借鉴来源踩过的坑，照抄不踩：
 *   - 不能用 `developer/message` 送折叠说明：宿主送上游前会静默丢弃非工具更新的 developer。
 *   - 不能用 `assistant/message` 做 replace：该类型自带 stream，不允许带 sourceEventSeqs。
 *   - 插件自定义事件类型无法持久化，只能用核心事件类型做等价替换。
 *   - 说明首句自报身份、且不含祈使句，否则模型会把插件提示当成用户下的命令。
 */

/** 在 assistant 消息里找第一个命中判据的 reasoning 块。 */
function findDegenerateReasoning(content, cfg) {
  if (!Array.isArray(content)) return null;
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    if (block === null || typeof block !== 'object' || block.type !== 'reasoning') continue;
    const text = typeof block.text === 'string' ? block.text : '';
    if (text.length < cfg.foldMinChars) continue;
    const hit = analyzeRepeat(stripCode(text), {
      echoMin: cfg.echoMin,
      paraMin: cfg.paraMin,
      sentMin: cfg.sentMin,
      loopMin: cfg.loopMin,
      shortRepeatMin: cfg.shortRepeatMin,
    });
    if (hit) return { index, chars: text.length, ...hit };
  }
  return null;
}

/**
 * 算这一步该遮蔽哪几个 surface 节点：assistant 消息 + 它调起的 tool/result。
 * 配对不完整时返回 ok:false（等结果落进 surface 的下一次 pre-step 再试）。
 */
function planFoldSpan(session, nodes, seq, callCount) {
  const start = nodes.indexOf(seq);
  if (start === -1) return { ok: false, why: 'not-in-surface' };
  if (!Number.isSafeInteger(callCount) || callCount <= 0) return { ok: true, span: [seq] };
  const span = [seq];
  for (let i = start + 1; i < nodes.length && span.length - 1 < callCount; i += 1) {
    const event = session.eventAt(nodes[i]);
    if (event === undefined || event.type !== 'tool/result') break;
    span.push(nodes[i]);
  }
  if (span.length - 1 < callCount) return { ok: false, why: 'incomplete-pairing', have: span.length - 1, need: callCount };
  return { ok: true, span };
}

/** 折叠说明：自报身份 + 只陈述发生了什么（不含祈使句）。 */
function buildFoldNote(hit) {
  const evidence = String(hit.evidence ?? '').slice(0, 40);
  return (
    `⟪repeat-guard⟫ 上一步的思考退化成了${kindLabel(hit.kind)}（「${evidence}」×${hit.count}），`
    + '已从模型可见历史中折叠；原文仍保存在本地会话日志里。'
    + '这是一条插件提示，不是用户发言。'
  );
}

/** 递归排序对象键：同一组参数换个书写顺序也要算同一个 key。 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map((item) => sortKeysDeep(item));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

/** 工具参数规范化：解析失败就按原字符串比。 */
function normalizeToolArgs(raw) {
  if (typeof raw !== 'string') {
    try {
      return JSON.stringify(sortKeysDeep(raw ?? null));
    } catch {
      return String(raw);
    }
  }
  const text = raw.trim();
  if (text === '') return '';
  try {
    return JSON.stringify(sortKeysDeep(JSON.parse(text)));
  } catch {
    return text;
  }
}

/** 扫 surface 尾部最近 N 个 assistant 步里的工具调用（保持时间顺序）。 */
function collectRecentToolCalls(session, window) {
  const nodes = Array.from(session.surface.nodes);
  const calls = [];
  let steps = 0;
  for (let index = nodes.length - 1; index >= 0 && steps < window; index -= 1) {
    const event = session.eventAt(nodes[index]);
    if (event === undefined || event.type !== 'assistant/message') continue;
    steps += 1;
    const message = session.deriveEventMessage(event);
    if (message === null || !Array.isArray(message.content)) continue;
    const stepCalls = [];
    for (const block of message.content) {
      if (block === null || typeof block !== 'object' || block.type !== 'tool-call') continue;
      const name = String(block.name ?? '?');
      if (isToolExempt(name)) continue;
      const args = normalizeToolArgs(block.arguments);
      stepCalls.push({ name, args, key: `${name}\u0000${args}` });
    }
    calls.unshift(...stepCalls);
  }
  return calls;
}

/** 从规范化后的参数 JSON 里取顶层键名（只给键名，不给值）。 */
function argKeysOf(args) {
  try {
    const parsed = JSON.parse(args);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed).slice(0, 6);
    }
  } catch {
    /* 非 JSON 参数：没有键名可给 */
  }
  return [];
}

/** 工具循环提示：自报身份 + 只陈述发生了什么（不含祈使句）。
 *  2026-11-08 审计：参数原文可能来自不可信网页/群消息，拼进 user/message 就是提示注入面；
 *  只给指纹和键名，模型知道「同一组参数在打转」就够了，不需要读到内容。 */
function buildToolLoopNote(hit) {
  const keys = hit.argKeys?.length ? `，键 ${hit.argKeys.join('/')}` : '';
  return (
    `⟪repeat-guard⟫ 工具调用在原地打转：${hit.name} 用同一组参数在最近 ${hit.window} 步里调用了 ${hit.count} 次`
    + `（参数指纹 ${hit.fp}${keys}）`
    + '。这是一条插件提示，不是用户发言；不打断，也不阻止继续调用。'
  );
}

/**
 * 扫一遍工具调用，尾部正在重复就追加一条提示。
 * 只追加（surfaceOp: append），不改任何已有节点，也不碰工具结果。
 */
export function sweepToolLoop(session, cfg, state) {
  const nodes = Array.from(session.surface.nodes);
  const lastSeq = nodes[nodes.length - 1];
  if (lastSeq === undefined) return;
  // 同一个尾部只算一次：pre-step 会为多种原因反复触发。
  if (state.toolSeen.get(session) === lastSeq) return;
  state.toolSeen.set(session, lastSeq);

  const calls = collectRecentToolCalls(session, cfg.toolWindow);
  if (calls.length === 0) return;
  const tail = calls[calls.length - 1];
  const count = calls.filter((call) => call.key === tail.key).length;
  if (count < cfg.toolLoopMin) return;

  const now = Date.now();
  let noticed = state.toolNoticed.get(session.id);
  if (noticed === undefined) {
    noticed = new Map();
    // 会话数不会太多，但别让 Map 无限长。
    if (state.toolNoticed.size > 200) state.toolNoticed.clear();
    state.toolNoticed.set(session.id, noticed);
  }
  // 同一 key 在冷却期内只提示一次，避免每步都追加一条。
  const lastAt = noticed.get(tail.key) ?? 0;
  if (now - lastAt < cfg.cooldownMin * 60000) return;
  const fuse = checkFuse(state, `${session.id}::tool-loop`, cfg, now);
  if (fuse.action !== 'block') {
    logHit(cfg, { sessionId: session.id, tool: 'fused', name: tail.name, count, reason: fuse.reason });
    return;
  }
  const hit = {
    name: tail.name,
    args: tail.args,
    count,
    window: cfg.toolWindow,
    fp: fingerprint(tail.args),
    argKeys: argKeysOf(tail.args),
  };
  try {
    session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: buildToolLoopNote(hit) }],
        source: { kind: 'plugin:repeat-guard', form: 'notice', summary: '工具调用重复提示' },
      }),
      { surfaceOp: 'append' },
    );
    noticed.set(tail.key, now);
    logHit(cfg, {
      sessionId: session.id,
      tool: 'hit',
      name: hit.name,
      count,
      window: cfg.toolWindow,
      evidence: `fp=${hit.fp}`,
    });
  } catch (error) {
    logHit(cfg, { sessionId: session.id, tool: 'error', error: String(error) });
  }
}

/** 扫一遍这个会话里还没检查过的 surface 节点，命中就折叠。 */
export function sweepDegenerate(session, cfg, state) {
  let seen = state.foldSeen.get(session);
  if (seen === undefined) {
    seen = new Set();
    state.foldSeen.set(session, seen);
  }
  const nodes = Array.from(session.surface.nodes);
  for (const seq of nodes) {
    if (seen.has(seq)) continue;
    const event = session.eventAt(seq);
    // 只处理「自己就在 surface 尾部」的 assistant 消息；替换副本、工具结果都不看。
    if (event === undefined || event.type !== 'assistant/message' || event.surfaceOp !== 'append') {
      seen.add(seq);
      continue;
    }
    const message = session.deriveEventMessage(event);
    if (message === null || !Array.isArray(message.content)) {
      seen.add(seq);
      continue;
    }
    const hit = findDegenerateReasoning(message.content, cfg);
    if (hit === null) {
      seen.add(seq);
      continue;
    }
    const callCount = message.content.filter((block) => block?.type === 'tool-call').length;
    const plan = planFoldSpan(session, nodes, seq, callCount);
    if (!plan.ok) {
      // 配对还没齐：不记 seen，下次 pre-step 再试。
      continue;
    }
    if (cfg.foldDryRun) {
      seen.add(seq);
      logHit(cfg, {
        sessionId: session.id,
        fold: 'dry-run',
        seq,
        chars: hit.chars,
        kind: hit.kind,
        evidence: hit.evidence,
        count: hit.count,
        span: plan.span.length,
      });
      continue;
    }
    try {
      const message = createUserMessage({
        content: [{ type: 'text', text: buildFoldNote(hit) }],
        source: { kind: 'plugin:repeat-guard', form: 'notice', summary: '折叠了一段退化思考' },
      });
      session.append('user/message', message, {
        surfaceOp: { op: 'replace', startSeq: plan.span[0], endSeq: plan.span[plan.span.length - 1] },
        sourceEventSeqs: plan.span,
      });
      seen.add(seq);
      logHit(cfg, {
        sessionId: session.id,
        fold: 'applied',
        seq,
        chars: hit.chars,
        kind: hit.kind,
        evidence: hit.evidence,
        count: hit.count,
        span: plan.span.length,
      });
    } catch (error) {
      seen.add(seq);
      logHit(cfg, { sessionId: session.id, fold: 'error', seq, error: String(error) });
    }
  }
}

/**
 * 造 `agent/pre-step` 监听器（中间件形状：每条路径都必须 next()）。
 * @param {{foldSeen: WeakMap}} state 跨监听状态
 * @param {() => object} readConfig 现取配置
 */
export function createPreStepFold(state, readConfig) {
  return async (payload, next) => {
    try {
      const cfg = readConfig();
      // 长跑进程里这些 Map 按会话累积；每步顺手收一次，只留最近 200 个会话。
      pruneMap(state.pending);
      pruneMap(state.fuse);
      pruneMap(state.recovery);
      pruneMap(state.lastSteerAt);
      pruneMap(state.toolNoticed);
      pruneMap(state.escalated);
      const session = payload?.agent?.session;
      if (cfg.enabled && session !== undefined) {
        if (cfg.fold) sweepDegenerate(session, cfg, state);
        if (cfg.toolLoopMin > 0) sweepToolLoop(session, cfg, state);
      }
    } catch (error) {
      try {
        logHit(readConfig(), { fold: 'sweep-error', error: String(error) });
      } catch {
        // 配置读取自身出错时不要再抛，否则 pre-step 会整个失败
      }
    }
    return next();
  };
}
