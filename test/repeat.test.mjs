import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeRepeat, detectTinyLines } from '../lib/repeat.js';

const BASE = {
  echoMin: 2,
  paraMin: 3,
  sentMin: 3,
  loopMin: 4,
  shortRepeatMin: 5,
  tinyRepeatMin: 5,
};

test('碎嘴短句连续 2 次判复读', () => {
  const hit = analyzeRepeat('写。\n写。\n写。', BASE);
  assert.ok(hit, '应命中');
  assert.equal(hit.kind, 'echo');
});

test('正常段落不误判', () => {
  const hit = analyzeRepeat('先看日志。\n再看配置。\n最后重启。', BASE);
  assert.equal(hit, null);
});

test('整段重复连续 3 行全等判复读', () => {
  const line = '这一段是完整的说明文字，长度足够不当作碎嘴短句。';
  const hit = analyzeRepeat([line, line, line].join('\n'), BASE);
  assert.ok(hit, '应命中');
});

test('同一长句出现 3 次判句子复读', () => {
  const s = '这是一个超过八个字的完整句子用来测试句子复读判据。';
  const hit = analyzeRepeat([s, '中间插入一句别的。', s, s].join('\n'), BASE);
  assert.ok(hit, '应命中');
});

test('sent：工具调用前导语不计入句子复读（2026-11-11 改动 5）', () => {
  // 日志实测：sent 判据 325 条命中里 302 条是这类括号前导语，只有 31 条是真截断。
  const pre = '（好，输出工具调用）';
  const lines = [];
  for (let i = 0; i < 10; i += 1) lines.push(pre, `第 ${i} 步处理不同的文件内容。`);
  const hit = analyzeRepeat(lines.join('\n'), BASE);
  assert.equal(hit, null, '前导语重复 10 次也不该判复读');
});

test('sent：真实句子复读仍命中（前导语豁免不放过真复读）', () => {
  const s = '这句话在每一行里都完整地重复出现。';
  const lines = [];
  for (let i = 0; i < 10; i += 1) lines.push(`第${i}段。${s}`);
  const hit = analyzeRepeat(lines.join('\n'), BASE);
  assert.ok(hit, '应命中');
  assert.equal(hit.kind, 'sent');
});

test('4 种句子循环 22 次：最后 20 句每种只剩 4 次也要命中（2026-11-09 实测漏判）', () => {
  const a = '但主人可能觉得这个工具慢是因为它没字幕时跑 ASR。';
  const b = '先回答：这个工具有字幕时快，没字幕时慢；另一个总是慢。';
  const c = '判断：这个工具不是最慢的那个——它比另一个快。';
  const d = '但主人说「是就删掉」——如果它是那个很慢的，就删。';
  const lines = [];
  for (let i = 0; i < 22; i += 1) lines.push(a, b, c, d);
  const hit = analyzeRepeat(lines.join('\n'), BASE);
  assert.ok(hit, '应命中');
  assert.equal(hit.kind, 'sent');
});

test('正常长文本里同一句偶尔出现 3 次不误判（去重率条件）', () => {
  const s = '这一句在正常长文里偶尔出现一次。';
  const lines = [];
  for (let i = 0; i < 30; i += 1) lines.push(`第 ${i} 行是各不相同的正常内容，用来稀释重复句。`);
  lines.push(s, '中间插一句别的。', s, '再插一句别的。', s);
  const hit = analyzeRepeat(lines.join('\n'), BASE);
  assert.equal(hit, null);
});

test('关闭全部判据时永不复读', () => {
  const off = { echoMin: 0, paraMin: 0, sentMin: 0, loopMin: 0, shortRepeatMin: 0 };
  const hit = analyzeRepeat('写。\n写。\n写。\n写。', off);
  assert.equal(hit, null);
});

test('nudge：2 行提醒不命中（2026-11-08 二次事故）', () => {
  const line = '（过程纪律提醒）上一步只执行了工具、没有输出正文。';
  const hit = analyzeRepeat([line, '正常的一句话。', line].join('\n'), BASE);
  assert.equal(hit, null);
});

test('nudge：连续 3 行提醒命中', () => {
  const a = '（过程纪律提醒）上一步只执行了工具、没有输出正文。';
  const b = '（过程纪律提醒）现在先用 1–3 句正文向用户说明。';
  const c = '（过程纪律提醒）刚做了什么、得出了什么结论、下一步做什么。';
  const hit = analyzeRepeat([a, b, c].join('\n'), BASE);
  assert.ok(hit, '应命中');
  assert.equal(hit.kind, 'nudge');
});

test('nudge：2 行提醒中间夹正常行不命中', () => {
  const a = '（过程纪律提醒）上一步只执行了工具、没有输出正文。';
  const b = '（过程纪律提醒）现在先用 1–3 句正文向用户说明。';
  const hit = analyzeRepeat([a, b, '正常的一句话。', '另一句正常的话。'].join('\n'), BASE);
  assert.equal(hit, null);
});

test('nudge：repeatGuardNudgeRun 可配（2 行即命中）', () => {
  const a = '（过程纪律提醒）上一步只执行了工具、没有输出正文。';
  const b = '（过程纪律提醒）现在先用 1–3 句正文向用户说明。';
  const hit = analyzeRepeat([a, b].join('\n'), { ...BASE, nudgeRun: 2 });
  assert.ok(hit, '应命中');
  assert.equal(hit.kind, 'nudge');
});

test('两字行口癖：40 行里 10 次「跑。」判打转（2026-11-16，独立于 4c）', () => {
  // 事故现场：session-c2fc7a1b 每调一次工具前打一行「跑。」，40 行窗口最多 13 次；
  // 4c 用 shortRepeatMin 而正文阈值被 bodyThresholds 翻倍（8→16）→ 漏判。
  const cfg = { ...BASE, shortRepeatMin: 99, tinyRepeatMin: 5 };
  const lines = [];
  for (let i = 0; i < 10; i += 1) lines.push('跑。', `第 ${i} 步读了一个不同的文件，写一句有内容的说明。`);
  const hit = analyzeRepeat(lines.join('\n'), cfg);
  assert.ok(hit, '应命中');
  assert.equal(hit.kind, 'loop');
  assert.match(hit.evidence, /跑/);
});

test('两字行口癖：次数够但占比不足 10% 不拦（占比门槛）', () => {
  // 40 行窗口里 3 次「跑。」= 7.5%，低于 TINY_SHARE 0.1
  const cfg = { ...BASE, shortRepeatMin: 99, tinyRepeatMin: 3 };
  const lines = [];
  for (let i = 0; i < 3; i += 1) lines.push('跑。', `第 ${i} 步读了一个不同的文件，写一句有内容的说明。`);
  while (lines.length < 40) lines.push(`第 ${lines.length} 行是各不相同的正常内容，用来稀释两字行占比。`);
  assert.equal(analyzeRepeat(lines.join('\n'), cfg), null);
});

test('两字行口癖：只出现 4 次不误判', () => {
  const cfg = { ...BASE, shortRepeatMin: 99, tinyRepeatMin: 5 };
  const lines = ['先看日志。', '跑。', '再看配置。', '跑。', '最后重启。', '跑。', '回话说明结论。', '跑。'];
  assert.equal(analyzeRepeat(lines.join('\n'), cfg), null);
});

test('两字行口癖：bodyGuard 关时正文通道仍命中（2026-11-16 补丁）', () => {
  // 事故现场：session-82bfbd92 第 38 轮每步工具前在正文打一行两字催促词；
  // 旧代码 4c/4d 都包在 if (cfg.bodyGuard) 里，而该开关默认关 → 一条都没拦。
  const cfg = { ...BASE, bodyGuard: false, shortRepeatMin: 99, tinyRepeatMin: 5 };
  const lines = [];
  for (let i = 0; i < 10; i += 1) lines.push('继续', `第 ${i} 步读了一个不同的文件，写一句有内容的说明。`);
  const hit = detectTinyLines(lines.join('\n'), cfg);
  assert.ok(hit, 'bodyGuard 关也要命中');
  assert.equal(hit.kind, 'loop');
});

test('nudge：repeatGuardNudgeRun 调高到 5 时 3 行不命中', () => {
  const a = '（过程纪律提醒）上一步只执行了工具、没有输出正文。';
  const b = '（过程纪律提醒）现在先用 1–3 句正文向用户说明。';
  const c = '（过程纪律提醒）刚做了什么、得出了什么结论、下一步做什么。';
  assert.equal(analyzeRepeat([a, b, c].join('\n'), { ...BASE, nudgeRun: 5 }), null);
});
