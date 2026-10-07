// 安全回归测试（1.7-preview5 Z1-Z3）：
// 验证 requireOwnership 的「默认拒绝（fail-closed）」语义——
// 远端无身份 / 冒用他人身份 / 非法身份一律拒绝，仅本机或 IP 匹配的账号放行。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 日志/数据写入临时目录，避免测试污染项目目录
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'localchat-unit-'));
process.env.LOCALCHAT_DATA_DIR = TMP_DIR;
test.after(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {}
});

const UserModel = require('../server/models/user');
const { requireOwnership, verifyAuthIp, normalizeIp } = require('../server/middleware/auth');

const LOCAL_IP = '127.0.0.1';
const ATTACKER_IP = '203.0.113.7'; // TEST-NET-3：不会与本机网卡重合
const VICTIM_IP = '203.0.113.9';

// 模拟账号：1=受害者（VICTIM_IP），2=攻击者自己的账号（ATTACKER_IP）
const originalFindById = UserModel.findById;
UserModel.findById = (id) =>
  ({
    1: { id: 1, ip: VICTIM_IP, username: 'victim' },
    2: { id: 2, ip: ATTACKER_IP, username: 'attacker' },
  })[Number(id)];

test.after(() => {
  UserModel.findById = originalFindById;
});

// 执行中间件并收集结果
function run(mw, req) {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  let passed = false;
  mw(req, res, () => {
    passed = true;
  });
  return { passed, res, req };
}

function makeReq(ip, query = {}) {
  return { ip, query, body: {}, method: 'GET', originalUrl: '/test' };
}

const mw = requireOwnership((req) => req.query.userId);

test('远端请求缺少 userId → 401 拒绝（原来会放行）', () => {
  const { passed, res } = run(mw, makeReq(ATTACKER_IP));
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
});

test('远端冒用他人 userId（IP 不符）→ 403 拒绝', () => {
  const { passed, res } = run(mw, makeReq(ATTACKER_IP, { userId: '1' }));
  assert.equal(passed, false);
  assert.equal(res.statusCode, 403);
});

test('远端使用自己 IP 的账号 → 放行并写入 req.authUserId', () => {
  const req = makeReq(ATTACKER_IP, { userId: '2' });
  const { passed } = run(mw, req);
  assert.equal(passed, true);
  assert.equal(req.authUserId, 2);
});

test('本机请求缺少 userId → 放行（插件/运维信任本机）', () => {
  const req = makeReq(LOCAL_IP);
  const { passed } = run(mw, req);
  assert.equal(passed, true);
  assert.equal(req.authUserId, null);
});

test('本机请求任意合法账号 → 放行', () => {
  const req = makeReq(LOCAL_IP, { userId: '1' });
  const { passed } = run(mw, req);
  assert.equal(passed, true);
  assert.equal(req.authUserId, 1);
});

test('非法 userId（非整数/负数/0）→ 401 拒绝', () => {
  for (const bad of ['abc', '1abc', '-1', '0', 'NaN']) {
    const { passed, res } = run(mw, makeReq(ATTACKER_IP, { userId: bad }));
    assert.equal(passed, false, `userId=${bad} 应被拒绝`);
    assert.equal(res.statusCode, 401);
  }
});

test('不存在的 userId → 401 拒绝（原来交给业务层）', () => {
  const { passed, res } = run(mw, makeReq(ATTACKER_IP, { userId: '999' }));
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
});

test('verifyAuthIp：IP 匹配/本机放行，其余拒绝', () => {
  const victim = { id: 1, ip: VICTIM_IP };
  assert.equal(verifyAuthIp(VICTIM_IP, victim), true);
  assert.equal(verifyAuthIp(`::ffff:${VICTIM_IP}`, victim), true);
  assert.equal(verifyAuthIp(LOCAL_IP, victim), true);
  assert.equal(verifyAuthIp(ATTACKER_IP, victim), false);
  assert.equal(verifyAuthIp(ATTACKER_IP, null), false);
});

test('normalizeIp：IPv6 映射地址还原', () => {
  assert.equal(normalizeIp('::ffff:192.168.1.5'), '192.168.1.5');
  assert.equal(normalizeIp('192.168.1.5'), '192.168.1.5');
  assert.equal(normalizeIp(undefined), '');
});
