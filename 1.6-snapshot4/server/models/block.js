const { getDb } = require('../db');
const logger = require('../logger');

class BlockModel {
  static block(userId, blockedUserId) {
    getDb()
      .prepare('INSERT OR IGNORE INTO blocked_users (user_id, blocked_user_id) VALUES (?, ?)')
      .run(userId, blockedUserId);
    logger.info(`用户拉黑: userId=${userId} blockedUserId=${blockedUserId}`);
    return { userId, blockedUserId };
  }

  static unblock(userId, blockedUserId) {
    getDb()
      .prepare('DELETE FROM blocked_users WHERE user_id = ? AND blocked_user_id = ?')
      .run(userId, blockedUserId);
    logger.info(`用户取消拉黑: userId=${userId} blockedUserId=${blockedUserId}`);
  }

  static getBlockedUsers(userId) {
    return getDb()
      .prepare(
        `SELECT u.id, u.ip, u.username, b.created_at as blocked_since
         FROM blocked_users b
         JOIN users u ON u.id = b.blocked_user_id
         WHERE b.user_id = ?
         ORDER BY b.created_at DESC`
      )
      .all(userId);
  }

  static isBlockedBy(senderId, receiverId) {
    const row = getDb()
      .prepare('SELECT 1 FROM blocked_users WHERE user_id = ? AND blocked_user_id = ?')
      .get(receiverId, senderId);
    return !!row;
  }
}

module.exports = BlockModel;
