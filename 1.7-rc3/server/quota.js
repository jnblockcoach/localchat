// F2：上传存储配额（单用户 + 全站），防止磁盘被上传填满
// 可通过环境变量调整：LOCALCHAT_USER_QUOTA_MB（默认 500）、LOCALCHAT_TOTAL_QUOTA_MB（默认 5120）
const { getDb } = require('./db');

function envMb(name, def) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const USER_QUOTA_MB = envMb('LOCALCHAT_USER_QUOTA_MB', 500);
const TOTAL_QUOTA_MB = envMb('LOCALCHAT_TOTAL_QUOTA_MB', 5120);
const MB = 1024 * 1024;

// 检查追加 addBytes 后是否超出配额
function checkUploadQuota(userId, addBytes) {
  const db = getDb();
  const add = Number(addBytes) || 0;

  const userSum = db
    .prepare('SELECT COALESCE(SUM(size), 0) AS s FROM files WHERE uploader_id = ?')
    .get(userId).s;
  if (userSum + add > USER_QUOTA_MB * MB) {
    return { ok: false, error: `个人存储空间不足（上限 ${USER_QUOTA_MB}MB）` };
  }

  const total = db.prepare('SELECT COALESCE(SUM(size), 0) AS s FROM files').get().s;
  if (total + add > TOTAL_QUOTA_MB * MB) {
    return { ok: false, error: '服务器存储空间不足，请联系管理员清理' };
  }

  return { ok: true };
}

module.exports = { checkUploadQuota, USER_QUOTA_MB, TOTAL_QUOTA_MB };
