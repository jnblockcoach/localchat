const { getDb } = require('../db');
const logger = require('../logger');

class UserModel {
  static findByIp(ip) {
    return getDb().prepare('SELECT * FROM users WHERE ip = ? ORDER BY created_at DESC').all(ip);
  }

  static findById(id) {
    return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  static create(ip, username) {
    const stmt = getDb().prepare('INSERT INTO users (ip, username) VALUES (?, ?)');
    const result = stmt.run(ip, username);
    const user = { id: result.lastInsertRowid, ip, username };
    logger.info(`用户注册: id=${user.id} username=${username} ip=${ip}`);
    return user;
  }

  static updateUsername(id, username) {
    getDb().prepare('UPDATE users SET username = ? WHERE id = ?').run(username, id);
    logger.info(`用户改名: id=${id} newUsername=${username}`);
    return this.findById(id);
  }

  static search(query) {
    // 转义 LIKE 通配符，避免 % 或 _ 触发全表匹配
    const escaped = String(query).replace(/[\\%_]/g, (m) => '\\' + m);
    const like = `%${escaped}%`;
    return getDb()
      .prepare("SELECT id, ip, username FROM users WHERE ip LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\' LIMIT 20")
      .all(like, like);
  }

  static getAllUsers() {
    return getDb().prepare('SELECT id, ip, username FROM users').all();
  }
}

module.exports = UserModel;
