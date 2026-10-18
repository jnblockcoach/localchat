// R19：孤儿文件清理
// 1) 数据库中超过保留期且没有任何消息引用的 files 记录（连同磁盘文件）
// 2) 磁盘上存在但数据库无记录、且超过保留期的文件
const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const logger = require('./logger');

const DATA_DIR = process.env.LOCALCHAT_DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'files');
const MAX_AGE_MS = 7 * 86400000; // 未发送文件保留 7 天

function sqliteCutoff(msAgo) {
  return new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');
}

function cleanupOrphanFiles() {
  const db = getDb();
  let removed = 0;

  // 1) DB 中无消息引用的过期文件
  const orphans = db
    .prepare(
      `SELECT f.* FROM files f
       WHERE f.created_at < ?
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.file_id = f.id)`
    )
    .all(sqliteCutoff(MAX_AGE_MS));

  for (const f of orphans) {
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, f.stored_name));
    } catch {}
    db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
    removed++;
  }

  // 2) 磁盘上无 DB 记录的过期文件
  try {
    const known = new Set(db.prepare('SELECT stored_name FROM files').all().map((r) => r.stored_name));
    for (const name of fs.readdirSync(UPLOAD_DIR)) {
      if (known.has(name)) continue;
      const full = path.join(UPLOAD_DIR, name);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && Date.now() - stat.mtimeMs > MAX_AGE_MS) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch {}
    }
  } catch {}

  if (removed > 0) logger.info(`孤儿文件清理: 删除 ${removed} 个（保留期 ${MAX_AGE_MS / 86400000} 天）`);
  return removed;
}

module.exports = { cleanupOrphanFiles, MAX_AGE_MS };
