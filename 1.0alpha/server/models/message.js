const { getDb } = require('../db');
const logger = require('../logger');

class MessageModel {
  static create(data) {
    const { type, senderId, receiverId, groupId, content, fileId } = data;
    const stmt = getDb().prepare(`
      INSERT INTO messages (type, sender_id, receiver_id, group_id, content, file_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(type, senderId, receiverId || null, groupId || null, content, fileId || null);
    const msg = this.getById(result.lastInsertRowid);
    logger.info(`消息已保存: id=${msg.id} type=${type} sender=${senderId}${groupId ? ` group=${groupId}` : ''}${receiverId ? ` to=${receiverId}` : ''}${fileId ? ` file=${fileId}` : ''}`);
    return msg;
  }

  static getById(id) {
    const msg = getDb()
      .prepare(
        `
      SELECT m.*, u.username as sender_name, u.ip as sender_ip
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.id = ?
    `
      )
      .get(id);
    if (msg && msg.file_id) {
      msg.file = getDb().prepare('SELECT * FROM files WHERE id = ?').get(msg.file_id);
    }
    return msg;
  }

  static recall(messageId, userId) {
    const msg = getDb().prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!msg) return null;
    if (Number(msg.sender_id) !== Number(userId)) return null;

    const now = new Date();
    const msgTime = new Date(msg.created_at + 'Z');
    const diffMs = now - msgTime;
    if (diffMs > 120000) return null;

    getDb().prepare("UPDATE messages SET status = 'recalled' WHERE id = ?").run(messageId);
    logger.info(`消息已撤回: id=${messageId} userId=${userId}`);
    return this.getById(messageId);
  }

  static _attachFiles(messages) {
    const attach = getDb().prepare('SELECT * FROM files WHERE id = ?');
    for (const msg of messages) {
      if (msg.file_id) {
        msg.file = attach.get(msg.file_id);
      }
    }
    return messages;
  }

  static getPrivateHistory(userId1, userId2, limit = 100, offset = 0) {
    const messages = getDb()
      .prepare(
        `
      SELECT m.*, u.username as sender_name, u.ip as sender_ip
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.type = 'private'
        AND ((m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?))
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `
      )
      .all(userId1, userId2, userId2, userId1, limit, offset)
      .reverse();
    return this._attachFiles(messages);
  }

  static getGroupHistory(groupId, limit = 100, offset = 0) {
    const messages = getDb()
      .prepare(
        `
      SELECT m.*, u.username as sender_name, u.ip as sender_ip
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.type = 'group' AND m.group_id = ?
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `
      )
      .all(groupId, limit, offset)
      .reverse();
    return this._attachFiles(messages);
  }

  static getUnreadCount(userId) {
    return getDb()
      .prepare(
        `
      SELECT COUNT(*) as count FROM messages
      WHERE type = 'private' AND receiver_id = ? AND status = 'sent'
    `
      )
      .get(userId);
  }
}

module.exports = MessageModel;
