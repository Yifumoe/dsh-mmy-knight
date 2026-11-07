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

test('关闭全部判据时永不复读', () => {
  const off = { echoMin: 0, paraMin: 0, sentMin: 0, loopMin: 0, shortRepeatMin: 0 };
  const hit = analyzeRepeat('写。\n写。\n写。\n写。', off);
  assert.equal(hit, null);
});
