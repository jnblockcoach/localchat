// F5：控制字符/不可见字符清理
const test = require('node:test');
const assert = require('node:assert');
const { stripControl, stripControlSingleLine } = require('../server/sanitize');

test('F5 · 剥离双向控制符/零宽字符，保留 emoji ZWJ', () => {
  // 显示欺骗：RLO 双向覆盖
  assert.equal(stripControlSingleLine('safe\u202Egnp.exe'), 'safegnp.exe');
  // 零宽空格 / LRM / RLM / BOM
  assert.equal(stripControlSingleLine('a\u200Bb'), 'ab');
  assert.equal(stripControlSingleLine('x\u200E\u200Fy'), 'xy');
  assert.equal(stripControlSingleLine('\uFEFFok'), 'ok');
  // U+2066-2069 双向隔离符
  assert.equal(stripControlSingleLine('a\u2066b\u2069c'), 'abc');
  // G5：软连字符 / ALM / 行分隔符
  assert.equal(stripControlSingleLine('a\u00adb'), 'ab');
  assert.equal(stripControlSingleLine('a\u061cb'), 'ab');
  assert.equal(stripControl('a\u2028b\u2029c'), 'abc');
  // 保留 U+200C/U+200D（emoji ZWJ 与部分文字需要）
  assert.equal(stripControl('👨\u200D👩'), '👨\u200D👩');
  // C0 控制字符（ESC/CR）
  assert.equal(stripControl('a\u001b[31mb'), 'a[31mb');
  assert.equal(stripControlSingleLine('a\r\nb'), 'ab');
});
