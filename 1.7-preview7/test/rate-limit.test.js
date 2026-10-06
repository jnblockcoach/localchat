// R16：HTTP 限流中间件测试（独立进程运行，先指向临时数据目录避免日志落项目）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'localchat-ratelimit-'));
process.env.LOCALCHAT_DATA_DIR = TMP;
test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

const { rateLimit } = require('../server/middleware/rateLimit');

function mockReq(ip = '127.0.0.1', urlPath = '/api/test') {
  return { ip, method: 'GET', baseUrl: '', path: urlPath };
}
function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  res.setHeader = () => {};
  return res;
}
function run(mw, req) {
  let passed = false;
  const res = mockRes();
  mw(req, res, () => {
    passed = true;
  });
  return { passed, res };
}

test('R16 · 超过窗口上限返回 429，窗口内正常放行', () => {
  const mw = rateLimit({ windowMs: 60000, max: 2 });
  assert.equal(run(mw, mockReq()).passed, true);
  assert.equal(run(mw, mockReq()).passed, true);
  const third = run(mw, mockReq());
  assert.equal(third.passed, false);
  assert.equal(third.res.statusCode, 429);

  // 不同 IP 各自独立计数
  assert.equal(run(mw, mockReq('10.0.0.9')).passed, true);
});
