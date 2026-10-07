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

test('F4 · 分段节奏：每 25 段停顿 4 秒，避免触发 WS 限流', async () => {
  const { chunkDelayMs } = await import(MOD);
  assert.equal(chunkDelayMs(0), 0);
  assert.equal(chunkDelayMs(24), 0);
  assert.equal(chunkDelayMs(25), 4000);
  assert.equal(chunkDelayMs(50), 4000);
  assert.equal(chunkDelayMs(51), 0);
});
