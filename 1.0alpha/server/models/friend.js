const { getDb } = require('../db');
const logger = require('../logger');

class FriendModel {
  static sendRequest(userId, friendId) {
    const stmt = getDb().prepare(
      'INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)'
    );
    const result = stmt.run(userId, friendId, 'pending');
    logger.info(`好友请求: from=${userId} to=${friendId} status=pending`);
    return { id: result.lastInsertRowid, userId, friendId, status: 'pending' };
  }

  static acceptRequest(userId, friendId) {
    const existing = getDb()
      .prepare('SELECT * FROM friends WHERE user_id = ? AND friend_id = ?')
      .get(friendId, userId);

    if (!existing) return null;

    getDb()
      .prepare('UPDATE friends SET status = ? WHERE user_id = ? AND friend_id = ?')
      .run('accepted', friendId, userId);

    getDb()
      .prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)')
      .run(userId, friendId, 'accepted');

    logger.info(`好友请求已接受: user=${userId} friend=${friendId}`);
    return { userId, friendId, status: 'accepted' };
  }

  static getFriends(userId) {
    const rows = getDb()
      .prepare(
        `
      SELECT u.id, u.ip, u.username, f.created_at as friend_since
      FROM friends f
      JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = ? AND f.status = 'accepted'
    `
      )
      .all(userId);
    return rows;
  }

  static getPendingRequests(userId) {
    return getDb()
      .prepare(
        `
      SELECT f.id as request_id, u.id, u.ip, u.username, f.created_at
      FROM friends f
      JOIN users u ON u.id = f.user_id
      WHERE f.friend_id = ? AND f.status = 'pending'
    `
      )
      .all(userId);
  }

  static getSentRequests(userId) {
    return getDb()
      .prepare(
        `
      SELECT f.id as request_id, u.id, u.ip, u.username, f.created_at
      FROM friends f
      JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = ? AND f.status = 'pending'
    `
      )
      .all(userId);
  }

  static getRelationship(userId, otherId) {
    const row = getDb()
      .prepare(
        `
      SELECT * FROM friends
      WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
    `
      )
      .get(userId, otherId, otherId, userId);
    return row || null;
  }

  static deleteFriend(userId, friendId) {
    getDb()
      .prepare(
        'DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)'
      )
      .run(userId, friendId, friendId, userId);
  }
}

module.exports = FriendModel;
