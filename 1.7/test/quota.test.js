// F2：上传存储配额
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'localchat-quota-'));
process.env.LOCALCHAT_DATA_DIR = TMP;
process.env.LOCALCHAT_USER_QUOTA_MB = '1';
process.env.LOCALCHAT_TOTAL_QUOTA_MB = '1';

const { initDatabase, getDb } = require('../server/db');
const { checkUploadQuota, USER_QUOTA_MB, TOTAL_QUOTA_MB } = require('../server/quota');
const UserModel = require('../server/models/user');

test.before(() => {
  initDatabase();
});
test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

function addFile(uploaderId, size) {
  getDb()
    .prepare(
      "INSERT INTO files (original_name, stored_name, mime_type, size, uploader_id) VALUES ('f','f','text/plain',?,?)"
    )
    .run(size, uploaderId);
}

test('F2 · 单用户配额与全站配额生效', () => {
  assert.equal(USER_QUOTA_MB, 1);
  assert.equal(TOTAL_QUOTA_MB, 1);

  const u1 = UserModel.create('127.0.0.1', 'q1');
  const u2 = UserModel.create('127.0.0.1', 'q2');

  addFile(u1.id, 600 * 1024);
  assert.equal(checkUploadQuota(u1.id, 300 * 1024).ok, true);

  const overUser = checkUploadQuota(u1.id, 500 * 1024);
  assert.equal(overUser.ok, false);
  assert.match(overUser.error, /个人存储空间/);

  // 全站累计超过 1MB：u2 自身未超个人配额，但全站超限
  addFile(u2.id, 500 * 1024);
  const overTotal = checkUploadQuota(u2.id, 1);
  assert.equal(overTotal.ok, false);
  assert.match(overTotal.error, /服务器存储空间/);
});
