// R2：AI 回复切分工具测试
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MOD = pathToFileURL(
  path.join(__dirname, '..', 'extensions', 'openclaw-channel-localchat', 'reply-utils.js')
).href;

test('R2 · splitReply 分段不丢内容且每段不超限', async () => {
  const { splitReply, REPLY_MAX } = await import(MOD);
  assert.equal(REPLY_MAX, 4000);

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
