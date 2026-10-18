// F7：日志大小轮转
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'localchat-log-'));
process.env.LOCALCHAT_DATA_DIR = TMP;
process.env.LOCALCHAT_LOG_MAX_BYTES = '300';
process.env.LOCALCHAT_LOG_REQUESTS = '0';

const LOG_DIR = path.join(TMP, 'logs');
// 抑制测试输出（logger 同时写 console）
const origLog = console.log;
const origWarn = console.warn;
const origErr = console.error;
console.log = () => {};
console.warn = () => {};
console.error = () => {};

const logger = require('../server/logger');

test.after(() => {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origErr;
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

test('F7 · 超过大小阈值自动轮转', () => {
  for (let i = 0; i < 20; i++) logger.info('x'.repeat(100) + '#' + i);

  const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.log'));
  assert.ok(files.length >= 2, `应发生轮转，实际文件: ${files.join(',')}`);

  const current = files.find((f) => /^server-\d{4}-\d{2}-\d{2}\.log$/.test(f));
  assert.ok(current, `当前日志文件应存在: ${files.join(',')}`);
  const size = fs.statSync(path.join(LOG_DIR, current)).size;
  assert.ok(size <= 500, `当前日志不应远超阈值: ${size}`);
});

test('F7 · LOCALCHAT_LOG_REQUESTS=0 时不挂 finish 监听', () => {
  let finishBound = false;
  let nextCalled = false;
  logger.request(
    { method: 'GET', originalUrl: '/x' },
    { on: () => { finishBound = true; } },
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, true);
  assert.equal(finishBound, false);
});
