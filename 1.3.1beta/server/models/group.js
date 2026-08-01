const { getDb } = require('../db');
const path = require('path');
const fs = require('fs');
const logger = require('../logger');

class GroupModel {
  static create(name, creatorId, memberIds) {
    const insertGroup = getDb().prepare('INSERT INTO groups (name, creator_id) VALUES (?, ?)');
    const insertMember = getDb().prepare(
      'INSERT OR IGNORE INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)'
    );

    const db = getDb();
    let groupId;
    try {
      db.exec('BEGIN TRANSACTION');
      const result = insertGroup.run(name, creatorId);
      const gid = result.lastInsertRowid;

      insertMember.run(gid, creatorId, 'admin');

      const uniqueIds = [...new Set(memberIds)];
      for (const mid of uniqueIds) {
        if (Number(mid) !== Number(creatorId)) {
          insertMember.run(gid, mid, 'member');
        }
      }

      db.exec('COMMIT');
      groupId = gid;
    } catch (error) {
      db.exec('ROLLBACK');
      logger.error(`创建群聊失败: name=${name} creator=${creatorId} error=${error.message}`);
      throw error;
    }
    logger.info(`群聊已创建: id=${groupId} name=${name} creator=${creatorId} members=${memberIds.length + 1}`);
    return this.getById(groupId);
  }

  static getById(groupId) {
    return getDb().prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  }

  static getUserGroups(userId) {
    return getDb()
      .prepare(
        `
      SELECT g.id, g.name, g.creator_id, g.announcement, g.created_at,
        (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count,
        (SELECT role FROM group_members WHERE group_id = g.id AND user_id = ?) as my_role,
        (SELECT 1 FROM group_mutes WHERE group_id = g.id AND user_id = ?) as is_muted
      FROM groups g
      JOIN group_members gm ON gm.group_id = g.id
      WHERE gm.user_id = ?
      ORDER BY g.created_at DESC
    `
      )
      .all(userId, userId, userId);
  }

  static getMembers(groupId) {
    return getDb()
      .prepare(
        `
      SELECT u.id, u.ip, u.username, gm.role, gm.joined_at
      FROM group_members gm
      JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ?
    `
      )
      .all(groupId);
  }

  static getMemberRole(groupId, userId) {
    const row = getDb()
      .prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(groupId, userId);
    return row ? row.role : null;
  }

  static isAdmin(groupId, userId) {
    const role = this.getMemberRole(groupId, userId);
    return role === 'admin';
  }

  static addMember(groupId, userId) {
    getDb()
      .prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)')
      .run(groupId, userId, 'member');
    logger.info(`群聊添加成员: groupId=${groupId} userId=${userId}`);
  }

  static removeMember(groupId, userId) {
    getDb()
      .prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?')
      .run(groupId, userId);
    logger.info(`群聊移除成员: groupId=${groupId} userId=${userId}`);
  }

  static deleteGroup(groupId, userId) {
    const group = this.getById(groupId);
    if (!group) return null;
    if (Number(group.creator_id) !== Number(userId)) return null;
    const db = getDb();
    db.exec('BEGIN TRANSACTION');
    try {
      const fileIds = db.prepare('SELECT DISTINCT file_id FROM messages WHERE group_id = ? AND file_id IS NOT NULL').all(groupId).map(r => r.file_id);
      db.prepare('DELETE FROM messages WHERE group_id = ?').run(groupId);
      db.prepare('DELETE FROM group_mutes WHERE group_id = ?').run(groupId);
      db.prepare('DELETE FROM group_members WHERE group_id = ?').run(groupId);
      db.prepare('DELETE FROM groups WHERE id = ?').run(groupId);
      for (const fid of fileIds) {
        const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fid);
        if (file) {
          const fpath = path.join(__dirname, '..', '..', 'data', 'files', file.stored_name);
          try { fs.unlinkSync(fpath); } catch {}
          db.prepare('DELETE FROM files WHERE id = ?').run(fid);
        }
      }
      db.exec('COMMIT');
      logger.info(`群聊已删除: groupId=${groupId} by userId=${userId}`);
      return true;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  static setAnnouncement(groupId, userId, announcement) {
    const group = this.getById(groupId);
    if (!group) return null;
    if (Number(group.creator_id) !== Number(userId)) return null;
    getDb().prepare('UPDATE groups SET announcement = ? WHERE id = ?').run(announcement, groupId);
    logger.info(`群公告已更新: groupId=${groupId} by userId=${userId}`);
    return this.getById(groupId);
  }

  static transferAdmin(groupId, fromUserId, toUserId) {
    const group = this.getById(groupId);
    if (!group) return null;
    if (Number(group.creator_id) !== Number(fromUserId)) return null;
    const db = getDb();
    db.exec('BEGIN TRANSACTION');
    try {
      db.prepare("UPDATE group_members SET role = 'member' WHERE group_id = ? AND user_id = ?").run(groupId, fromUserId);
      db.prepare("UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?").run(groupId, toUserId);
      db.prepare('UPDATE groups SET creator_id = ? WHERE id = ?').run(toUserId, groupId);
      db.exec('COMMIT');
      logger.info(`群管理员已迁移: groupId=${groupId} from=${fromUserId} to=${toUserId}`);
      return this.getById(groupId);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  static isMuted(userId, groupId) {
    const row = getDb()
      .prepare('SELECT 1 FROM group_mutes WHERE user_id = ? AND group_id = ?')
      .get(userId, groupId);
    return !!row;
  }

  static toggleMute(userId, groupId) {
    if (this.isMuted(userId, groupId)) {
      getDb().prepare('DELETE FROM group_mutes WHERE user_id = ? AND group_id = ?').run(userId, groupId);
      logger.info(`群聊取消免打扰: groupId=${groupId} userId=${userId}`);
      return false;
    }
    getDb()
      .prepare('INSERT OR IGNORE INTO group_mutes (user_id, group_id) VALUES (?, ?)')
      .run(userId, groupId);
    logger.info(`群聊免打扰已开启: groupId=${groupId} userId=${userId}`);
    return true;
  }
}

module.exports = GroupModel;
