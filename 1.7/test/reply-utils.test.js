// R2：AI 回复切分工具测试
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MOD = pathToFileURL(
  path.join(__dirname, '..', 'extensions', 'openclaw-channel-localchat', 'reply-utils.js')
).href;

test('R2 · splitReply 分段不丢内容且每段不超限', async () => {
  const { splitReply, REPLY_MAX, REPLY_CHUNK_LIMIT } = await import(MOD);
  assert.equal(REPLY_MAX, 4000);
  assert.equal(REPLY_CHUNK_LIMIT, 100);

  assert.deepEqual(splitReply(''), []);
  assert.deepEqual(splitReply('short'), ['short']);

  const long = 'a'.repeat(9000);
  const chunks = splitReply(long, 4000);
  assert.ok(chunks.length >= 3, `应切分为多段: ${chunks.length}`);
  assert.ok(chunks.every((c) => c.length <= 4000));
  assert.equal(chunks.join(''), long);

  // 优先在换行处切分
  const text = 'x'.repeat(3900) + '\n' + 'y'.repeat(300);
  const cs = splitReply(text, 4000);
  assert.equal(cs.length, 2);
  assert.equal(cs[0], 'x'.repeat(3900));
  assert.equal(cs[1], 'y'.repeat(300));
});

test('F4/G1 · 分段节奏：每 25 段停顿 >10 秒（固定窗口 30 条/10 秒）', async () => {
  const { chunkDelayMs, CHUNK_PAUSE_MS } = await import(MOD);
  assert.ok(CHUNK_PAUSE_MS > 10000, '停顿必须超过服务端 10 秒窗口');
  assert.equal(chunkDelayMs(0), 0);
  assert.equal(chunkDelayMs(24), 0);
  assert.equal(chunkDelayMs(25), CHUNK_PAUSE_MS);
  assert.equal(chunkDelayMs(50), CHUNK_PAUSE_MS);
  assert.equal(chunkDelayMs(51), 0);
});

test('G2 · 截断提示不会使末段超过 4000 字上限', async () => {
  const { fitNotice, TRUNC_NOTICE, REPLY_MAX } = await import(MOD);
  // 恰好 4000 字的末段
  const full = fitNotice('x'.repeat(4000), TRUNC_NOTICE);
  assert.ok(full.length <= REPLY_MAX, `长度应为 ${full.length}`);
  assert.ok(full.endsWith(TRUNC_NOTICE));
  // 短末段直接追加
  const short = fitNotice('hello', TRUNC_NOTICE);
  assert.equal(short, 'hello' + TRUNC_NOTICE);
});

test('G1 仿真 · 当前 10.5 秒停顿在服务端固定窗口下不丢段', async () => {
  const { chunkDelayMs } = await import(MOD);
  // 按服务端固定窗口逻辑模拟 100 段发送
  let start = null;
  let count = 0;
  let dropped = 0;
  let t = 0;
  for (let i = 0; i < 100; i++) {
    t += chunkDelayMs(i);
    if (start === null || t - start > 10000) {
      start = t;
      count = 0;
    }
    count++;
    if (count > 30) dropped++;
  }
  assert.equal(dropped, 0, `不应有分段被服务端限流丢弃（dropped=${dropped}）`);
});
