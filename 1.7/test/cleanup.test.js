// R19/R12：孤儿文件清理与异常时间撤回
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'localchat-model-'));
process.env.LOCALCHAT_DATA_DIR = TMP;

const { initDatabase, getDb } = require('../server/db');
const { cleanupOrphanFiles, MAX_AGE_MS } = require('../server/cleanup');
const MessageModel = require('../server/models/message');
const UserModel = require('../server/models/user');

test.before(() => {
  initDatabase();
});
test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

test('R19 · 孤儿文件清理：过期未引用删除，被引用/未过期保留', () => {
  const db = getDb();
  const filesDir = path.join(TMP, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  const oldTime = new Date(Date.now() - MAX_AGE_MS - 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const user = UserModel.create('127.0.0.1', 'u1');

  // 过期且无消息引用 → 应删除
  fs.writeFileSync(path.join(filesDir, 'old.txt'), 'x');
  db.prepare(
    "INSERT INTO files (original_name, stored_name, mime_type, size, uploader_id, created_at) VALUES ('old.txt','old.txt','text/plain',1,?,?)"
  ).run(user.id, oldTime);

  // 过期但有消息引用 → 应保留
  fs.writeFileSync(path.join(filesDir, 'used.txt'), 'y');
  const usedId = db
    .prepare(
      "INSERT INTO files (original_name, stored_name, mime_type, size, uploader_id, created_at) VALUES ('used.txt','used.txt','text/plain',1,?,?)"
    )
    .run(user.id, oldTime).lastInsertRowid;
  db.prepare(
    "INSERT INTO messages (type, sender_id, receiver_id, content, file_id, created_at) VALUES ('private', ?, ?, 'used.txt', ?, ?)"
  ).run(user.id, user.id, usedId, oldTime);

  // 磁盘孤儿（无 DB 记录）且过期 → 应删除
  const diskOrphan = path.join(filesDir, 'disk-orphan.txt');
  fs.writeFileSync(diskOrphan, 'z');
  const past = new Date(Date.now() - MAX_AGE_MS - 86400000);
  fs.utimesSync(diskOrphan, past, past);

  const removed = cleanupOrphanFiles();
  assert.ok(removed >= 2, `应至少清理 2 个，实际 ${removed}`);
  assert.ok(!fs.existsSync(path.join(filesDir, 'old.txt')), '过期未引用文件应删除');
  assert.ok(fs.existsSync(path.join(filesDir, 'used.txt')), '被引用文件应保留');
  assert.ok(!fs.existsSync(diskOrphan), '磁盘孤儿应删除');
});

test('R12 · created_at 异常时撤回被拒绝', () => {
  const db = getDb();
  const u = UserModel.create('127.0.0.1', 'u2');
  const id = db
    .prepare(
      "INSERT INTO messages (type, sender_id, receiver_id, content, created_at) VALUES ('private', ?, ?, 'x', 'not-a-date')"
    )
    .run(u.id, u.id).lastInsertRowid;
  assert.equal(MessageModel.recall(Number(id), u.id), null);
});

test('F6 · 重复撤回被拒绝（避免广播放大）', () => {
  const db = getDb();
  const u = UserModel.create('127.0.0.1', 'u3');
  const id = db
    .prepare("INSERT INTO messages (type, sender_id, receiver_id, content) VALUES ('private', ?, ?, 'x')")
    .run(u.id, u.id).lastInsertRowid;
  assert.ok(MessageModel.recall(Number(id), u.id), '首次撤回应成功');
  assert.equal(MessageModel.recall(Number(id), u.id), null, '重复撤回应被拒绝');
});
