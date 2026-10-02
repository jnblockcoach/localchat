// 集成回归测试（1.7-preview6）：
// 启动真实服务器（独立端口 + 临时数据目录），用 HTTP/WS 复现并验证以下修复：
//   H1/M7 文件引用越权、H4 登录 IP 校验、H5 重复 auth、M1 中文 @、M2 非好友私聊、
//   M3 超长消息、M4 负数 limit、M5 AI 注册仅限本机
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const PORT = 3199;
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

let child = null;
let tmpDir = null;

// 用指定源 IP 发请求（127.0.0.2 模拟局域网另一台机器）
function requestAs(localAddress, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        localAddress,
        path: urlPath,
        method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode, json, raw });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function api(pathname, options = {}) {
  const res = await fetch(BASE + pathname, options);
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

async function register(username) {
  const r = await api('/api/users/register', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ username: username || `用户${Date.now()}${Math.floor(Math.random() * 1000)}` }),
  });
  assert.ok(r.json && r.json.user, `注册失败: ${r.raw}`);
  return r.json.user;
}

async function makeFriends(aId, bId) {
  await api('/api/friends/add', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ userId: aId, friendId: bId }),
  });
  await api('/api/friends/accept', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ userId: bId, friendId: aId }),
  });
}

// WS 连接并认证；返回 socket 与事件收集数组
function wsAuth(userId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${PORT}`);
    const events = [];
    ws.on('message', (raw) => {
      try {
        events.push(JSON.parse(raw.toString()));
      } catch {}
    });
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', userId })));
    setTimeout(() => resolve({ ws, events }), 400);
  });
}

function waitFor(events, type, timeout = 1500) {
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const hit = events.find((e) => e.type === type);
      if (hit) {
        clearInterval(timer);
        resolve(hit);
      } else if (Date.now() - start > timeout) {
        clearInterval(timer);
        resolve(null);
      }
    }, 50);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localchat-test-'));
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), LOCALCHAT_DATA_DIR: tmpDir },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 8000;
  for (;;) {
    const up = await fetch(BASE + '/api/users/online').then((r) => r.ok).catch(() => false);
    if (up) break;
    if (Date.now() > deadline) throw new Error('测试服务器启动超时');
    await sleep(100);
  }
});

test.after(() => {
  if (child) child.kill('SIGKILL');
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});

test('H5 · 同一连接重复 auth 被拒绝，且不会串收他人消息', async () => {
  const a = await register('h5-a');
  const b = await register('h5-b');
  const c = await register('h5-c');
  await makeFriends(a.id, c.id);
  await makeFriends(b.id, c.id);

  const { ws, events } = await wsAuth(a.id);
  await sleep(200);
  assert.ok(events.some((e) => e.type === 'authenticated'));

  // 同一连接再以 B 身份认证 → 必须被拒绝
  ws.send(JSON.stringify({ type: 'auth', userId: b.id }));
  const err = await waitFor(events, 'error');
  assert.ok(err && /已认证/.test(err.message), `应返回已认证错误: ${JSON.stringify(err)}`);

  // 清空事件：C 发给 B 不应送到本连接（本连接仍属于 A）
  events.length = 0;
  const cWs = await wsAuth(c.id);
  await sleep(200);
  cWs.ws.send(JSON.stringify({ type: 'private_msg', receiverId: b.id, content: 'to-b' }));
  await sleep(500);
  assert.equal(events.filter((e) => e.type === 'new_private_msg').length, 0);

  // C 发给 A 应正常送达（连接仍是 A 的）
  cWs.ws.send(JSON.stringify({ type: 'private_msg', receiverId: a.id, content: 'to-a' }));
  const delivered = await waitFor(events, 'new_private_msg');
  assert.ok(delivered && delivered.message.content === 'to-a');

  ws.close();
  cWs.ws.close();
});

test('H1/M7 · 不能引用他人文件发送，未引用文件不可下载', async () => {
  const bob = await register('h1-bob');
  const alice = await register('h1-alice');
  const carol = await register('h1-carol');

  // bob 上传一个从未发送的文件
  const form = new FormData();
  form.append('file', new Blob(['TOP SECRET']), 'secret.txt');
  form.append('uploaderId', String(bob.id));
  const up = await api(`/api/files/upload?uploaderId=${bob.id}`, { method: 'POST', body: form });
  assert.ok(up.json && up.json.file, `上传失败: ${up.raw}`);
  const fileId = up.json.file.id;

  // alice 建群（成员 alice + carol），尝试把 bob 的文件发进群
  const g = await api('/api/groups/create', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: 'h1-group', creatorId: alice.id, memberIds: [carol.id] }),
  });
  assert.ok(g.json && g.json.group, `建群失败: ${g.raw}`);
  const groupId = g.json.group.id;

  const { ws, events } = await wsAuth(alice.id);
  ws.send(JSON.stringify({ type: 'file_msg', groupId, fileId }));
  const err = await waitFor(events, 'error');
  assert.ok(err && /无权发送该文件/.test(err.message), `应拒绝引用他人文件: ${JSON.stringify(err)}`);

  // 文件从未被引用：其他用户下载/查看信息都应 403
  const dl = await fetch(`${BASE}/api/files/${fileId}/download?userId=${carol.id}`);
  assert.equal(dl.status, 403);
  const info = await api(`/api/files/${fileId}/info?userId=${alice.id}`);
  assert.equal(info.status, 403);

  // 上传者本人仍可下载（回归）
  const own = await fetch(`${BASE}/api/files/${fileId}/download?userId=${bob.id}`);
  assert.equal(own.status, 200);

  ws.close();
});

test('H4 · 跨 IP 登录被拒绝，本机登录正常', async () => {
  const u = await register('h4-user');
  const remote = await requestAs('127.0.0.2', 'POST', '/api/users/login', { id: u.id });
  assert.equal(remote.status, 403);
  const local = await requestAs('127.0.0.1', 'POST', '/api/users/login', { id: u.id });
  assert.equal(local.status, 200);
});

test('M5 · AI 注册仅限服务器本机', async () => {
  const remote = await requestAs('127.0.0.2', 'POST', '/api/ai/register', { username: 'remote-ai' });
  assert.equal(remote.status, 403);
});

test('M2 · 非好友私聊被拒绝', async () => {
  const a = await register('m2-a');
  const b = await register('m2-b');
  const { ws, events } = await wsAuth(a.id);
  ws.send(JSON.stringify({ type: 'private_msg', receiverId: b.id, content: 'hi' }));
  const err = await waitFor(events, 'error');
  assert.ok(err && /还不是好友/.test(err.message), `应拒绝非好友私聊: ${JSON.stringify(err)}`);
  ws.close();
});

test('M3 · 超长消息被拒绝', async () => {
  const a = await register('m3-a');
  const b = await register('m3-b');
  await makeFriends(a.id, b.id);
  const { ws, events } = await wsAuth(a.id);
  ws.send(JSON.stringify({ type: 'private_msg', receiverId: b.id, content: 'x'.repeat(4001) }));
  const err = await waitFor(events, 'error');
  assert.ok(err && /消息过长/.test(err.message), `应拒绝超长消息: ${JSON.stringify(err)}`);
  ws.close();
});

test('M4 · limit 负数被夹到 1', async () => {
  const a = await register('m4-a');
  const b = await register('m4-b');
  await makeFriends(a.id, b.id);
  const { ws, events } = await wsAuth(a.id);
  ws.send(JSON.stringify({ type: 'private_msg', receiverId: b.id, content: 'm1' }));
  assert.ok(await waitFor(events, 'new_private_msg'));
  ws.send(JSON.stringify({ type: 'private_msg', receiverId: b.id, content: 'm2' }));
  await sleep(300);

  const res = await api(`/api/messages/private/${a.id}/${b.id}?limit=-1&userId=${a.id}`);
  assert.ok(Array.isArray(res.json));
  assert.equal(res.json.length, 1);
  ws.close();
});

test('M1 · 中文用户名 @ 提醒可用', async () => {
  const alice = await register('m1-alice');
  const ming = await register('小明');
  const g = await api('/api/groups/create', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: 'm1-group', creatorId: alice.id, memberIds: [ming.id] }),
  });
  assert.ok(g.json && g.json.group, `建群失败: ${g.raw}`);
  const groupId = g.json.group.id;

  const aliceWs = await wsAuth(alice.id);
  const mingWs = await wsAuth(ming.id);
  await sleep(200);
  aliceWs.ws.send(JSON.stringify({ type: 'group_msg', groupId, content: '@小明 你好' }));
  const mention = await waitFor(mingWs.events, 'mention');
  assert.ok(mention, `小明应收到 @ 提醒: ${JSON.stringify(mingWs.events)}`);
  assert.equal(mention.from.username, 'm1-alice');
  aliceWs.ws.close();
  mingWs.ws.close();
});
