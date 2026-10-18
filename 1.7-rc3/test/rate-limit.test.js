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

const { rateLimit, _bucketCount } = require('../server/middleware/rateLimit');

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

test('F1 · 桶数量有硬上限（防内存/CPU 被打爆）', () => {
  const mw = rateLimit({ windowMs: 60000, max: 1000000 });
  const res = mockRes();
  const before = Date.now();
  for (let i = 0; i < 25000; i++) {
    mw({ ip: '10.9.9.9', method: 'GET', baseUrl: '/api', path: '/x' + i }, res, () => {});
  }
  assert.ok(_bucketCount() <= 20000, `桶数量应被限制，实际 ${_bucketCount()}`);
  // 摊销后 2.5 万次不同路径调用应远快于 O(n²) 的实现
  assert.ok(Date.now() - before < 5000, '限流器不应随桶数量线性变慢');
});

test('G3 · 全局 IP 限流不会因大量不同路径被挤出（限流不可绕过）', () => {
  const globalMw = rateLimit({ windowMs: 60000, max: 1000000, keyBy: 'ip' });
  const loginMw = rateLimit({ windowMs: 60000, max: 30 });
  const res = mockRes();
  const req = (path) => ({ ip: '10.7.7.7', method: 'POST', baseUrl: '/api', path });

  let allowed = 0;
  for (let i = 0; i < 31; i++) {
    let pass = false;
    loginMw(req('/users/login'), res, () => {
      pass = true;
    });
    if (pass) allowed++;
  }
  assert.equal(allowed, 30);

  // 洪泛 2 万不同路径（含 404），只应产生极少全局桶
  for (let i = 0; i < 20001; i++) globalMw(req('/random-' + i), res, () => {});

  let pass = false;
  loginMw(req('/users/login'), res, () => {
    pass = true;
  });
  assert.equal(pass, false, '洪泛后 login 限流仍应生效');
});
