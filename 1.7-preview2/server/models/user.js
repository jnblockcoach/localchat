const { getDb } = require('../db');
const logger = require('../logger');

class UserModel {
  static findByIp(ip) {
    // 按注册顺序（id 升序），保证 IP-序号 与注册顺序一致
    return getDb().prepare('SELECT * FROM users WHERE ip = ? ORDER BY id ASC').all(ip);
  }

  // 按 IP 查询并附带账号序号（该 IP 下第几个注册，从 1 开始；AI 账号不占用普通序号）
  static findByIpWithIndex(ip) {
    const users = this.findByIp(ip);
    let n = 0;
    return users.map((u) => {
      if (u.is_ai) return { ...u, ip_index: 0 };
      n++;
      return { ...u, ip_index: n };
    });
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

  // AI 助理账号（手工注册，标记 is_ai=1）
  static createAi(ip, username) {
    // AI 序号：该 IP 下已有的 AI 数量 + 1（全局唯一 AI，通常为 1）
    const cnt = getDb().prepare('SELECT COUNT(*) as c FROM users WHERE ip = ? AND is_ai = 1').get(ip);
    const aiSeq = (cnt ? cnt.c : 0) + 1;
    const displayId = `openclaw-${ip}-${aiSeq}`;
    const stmt = getDb().prepare('INSERT INTO users (ip, username, is_ai, display_id) VALUES (?, ?, 1, ?)');
    const result = stmt.run(ip, username, displayId);
    const user = { id: result.lastInsertRowid, ip, username, is_ai: 1, display_id: displayId };
    logger.info(`AI 助理注册: id=${user.id} username=${username} display_id=${displayId} ip=${ip}`);
    return user;
  }

  // 查询已注册的 AI 助理账号
  static findAiAccount() {
    return getDb().prepare('SELECT * FROM users WHERE is_ai = 1 ORDER BY id ASC LIMIT 1').get() || null;
  }

  // 按显示 ID（openclaw-IP-序号）查找账号
  static findByDisplayId(displayId) {
    return getDb().prepare('SELECT * FROM users WHERE display_id = ?').get(displayId) || null;
  }

  // 指定账号在该 IP 下的普通用户序号（IP-N 的 N；AI 账号不占用普通序号）
  static getAccountIndex(ip, id) {
    const row = getDb().prepare('SELECT COUNT(*) as c FROM users WHERE ip = ? AND is_ai = 0 AND id <= ?').get(ip, id);
    return row ? row.c : 1;
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
