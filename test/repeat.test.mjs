import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeRepeat } from '../lib/repeat.js';

const BASE = {
  echoMin: 2,
  paraMin: 3,
  sentMin: 3,
  loopMin: 4,
  shortRepeatMin: 5,
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

test('nudge：repeatGuardNudgeRun 调高到 5 时 3 行不命中', () => {
  const a = '（过程纪律提醒）上一步只执行了工具、没有输出正文。';
  const b = '（过程纪律提醒）现在先用 1–3 句正文向用户说明。';
  const c = '（过程纪律提醒）刚做了什么、得出了什么结论、下一步做什么。';
  assert.equal(analyzeRepeat([a, b, c].join('\n'), { ...BASE, nudgeRun: 5 }), null);
});
