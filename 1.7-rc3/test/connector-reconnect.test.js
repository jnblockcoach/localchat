// R1：连接器在服务器短暂宕机后必须能自动恢复
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('node:url');

const PORT = 3198;
const BASE = `http://127.0.0.1:${PORT}`;
let tmpDir = null;
let child = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await fetch(BASE + '/api/users/online').then((r) => r.ok).catch(() => false);
    if (ok) return;
    if (Date.now() > deadline) throw new Error('测试服务器启动超时');
    await sleep(100);
  }
}

async function startServer() {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), LOCALCHAT_DATA_DIR: tmpDir },
    stdio: 'ignore',
  });
  await waitReady();
}

async function killServer() {
  if (!child) return;
  child.kill('SIGKILL');
  child = null;
  await sleep(300);
}

// 直接造一个 AI 账号（避免测试依赖本机 OpenClaw）
function insertAiAccount() {
  const db = new DatabaseSync(path.join(tmpDir, 'chat.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare(
      "INSERT INTO users (ip, username, is_ai, display_id) VALUES ('127.0.0.1','AI助手',1,'openclaw-127.0.0.1-1')"
    ).run();
  } finally {
    db.close();
  }
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localchat-conn-'));
  await startServer();
  insertAiAccount();
});

test.after(async () => {
  await killServer();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

test('R1 · 服务器短暂宕机恢复后连接器自动重连', async () => {
  const { LocalChatConnector } = await import(
    pathToFileURL(path.join(__dirname, '..', 'extensions', 'openclaw-channel-localchat', 'connector.js')).href
  );
  const conn = new LocalChatConnector({ serverUrl: BASE, botUsername: 'AI助手', log: () => {} });
  const started = await conn.start();
  assert.ok(started, '连接器应发现 AI 账号并启动');

  const openDeadline = Date.now() + 5000;
  while ((!conn.ws || conn.ws.readyState !== 1) && Date.now() < openDeadline) await sleep(100);
  assert.equal(conn.ws && conn.ws.readyState, 1, '初始连接应为 OPEN');

  // 宕机窗口 5 秒：覆盖 3 秒重连定时器，使首次 _safeReconnect 必然遇到服务器不可达
  await killServer();
  await sleep(5000);
  await startServer();

  const recoverDeadline = Date.now() + 20000;
  while ((!conn.ws || conn.ws.readyState !== 1) && Date.now() < recoverDeadline) await sleep(200);
  const recovered = conn.ws && conn.ws.readyState === 1;
  conn.stop();
  assert.ok(recovered, '服务器恢复后连接器应自动重连（R1）');
});
