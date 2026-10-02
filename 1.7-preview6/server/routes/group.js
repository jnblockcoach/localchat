const express = require('express');
const GroupModel = require('../models/group');
const UserModel = require('../models/user');
const { requireOwnership } = require('../middleware/auth');
const logger = require('../logger');

const router = express.Router();

const NAME_MAX = 30;
const ANNOUNCEMENT_MAX = 500;
const MEMBER_MAX = 200;

router.post('/create', requireOwnership((req) => req.body.creatorId), (req, res) => {
  try {
    const { name, creatorId, memberIds } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: '群名称不能为空' });
    }
    if (name.trim().length > NAME_MAX) {
      return res.status(400).json({ error: `群名称不能超过 ${NAME_MAX} 个字符` });
    }
    if (!creatorId) {
      return res.status(400).json({ error: '缺少创建者ID' });
    }

    // L3：memberIds 必须是数组；过滤非法/不存在的用户，避免 FK 异常导致 500
    const rawIds = Array.isArray(memberIds) ? memberIds : [];
    const memberList = [...new Set(rawIds.map(Number))].filter(
      (id) => Number.isInteger(id) && id > 0 && id !== Number(creatorId) && UserModel.findById(id)
    );
    if (memberList.length > MEMBER_MAX) {
      return res.status(400).json({ error: `群成员不能超过 ${MEMBER_MAX} 人` });
    }

    const group = GroupModel.create(name.trim(), creatorId, memberList);
    const members = GroupModel.getMembers(group.id);
    res.json({ group, members });
  } catch (err) {
    logger.error(`创建群聊失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/add-member', requireOwnership((req) => req.body.opUserId), (req, res) => {
  try {
    const { groupId, userId, opUserId } = req.body;
    if (!groupId || !userId || !opUserId) {
      return res.status(400).json({ error: '缺少参数' });
    }
    // L3：先验证群与目标用户存在，避免 FK 异常导致 500
    if (!GroupModel.getById(groupId)) return res.status(404).json({ error: '群不存在' });
    if (!UserModel.findById(userId)) return res.status(404).json({ error: '用户不存在' });
    if (!GroupModel.isAdmin(groupId, opUserId)) {
      return res.status(403).json({ error: '只有群管理员才能添加成员' });
    }
    if (GroupModel.getMembers(groupId).length >= MEMBER_MAX) {
      return res.status(400).json({ error: `群成员不能超过 ${MEMBER_MAX} 人` });
    }
    GroupModel.addMember(groupId, userId);
    const members = GroupModel.getMembers(groupId);
    res.json({ members });
  } catch (err) {
    logger.error(`添加群成员失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/remove-member', requireOwnership((req) => req.body.opUserId), (req, res) => {
  try {
    const { groupId, userId, opUserId } = req.body;
    if (!groupId || !userId || !opUserId) {
      return res.status(400).json({ error: '缺少参数' });
    }
    // L3：群不存在时返回 404，而不是 403/静默失败
    if (!GroupModel.getById(groupId)) return res.status(404).json({ error: '群不存在' });
    if (!GroupModel.isAdmin(groupId, opUserId)) {
      return res.status(403).json({ error: '只有群管理员才能移除成员' });
    }
    const target = GroupModel.getById(groupId);
    if (target && Number(target.creator_id) === Number(userId)) {
      return res.status(403).json({ error: '不能移除群创建者' });
    }
    GroupModel.removeMember(groupId, userId);
    const members = GroupModel.getMembers(groupId);
    res.json({ members });
  } catch (err) {
    logger.error(`移除群成员失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', requireOwnership((req) => req.query.userId), (req, res) => {
  try {
    const userId = req.authUserId;
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    const groups = GroupModel.getUserGroups(userId);
    res.json(groups);
  } catch (err) {
    logger.error(`获取用户群聊失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/members', requireOwnership((req) => req.query.userId), (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const userId = req.authUserId;
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    // 身份已经过 IP 验证，成员资格必须校验（不再允许“不带 userId 绕过”）
    if (!GroupModel.getMemberRole(groupId, userId)) {
      return res.status(403).json({ error: '你不是该群成员' });
    }
    const members = GroupModel.getMembers(groupId);
    res.json(members);
  } catch (err) {
    logger.error(`获取群成员失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', requireOwnership((req) => req.query.userId), (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const userId = req.authUserId;
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    const group = GroupModel.getById(groupId);
    if (!group) return res.status(404).json({ error: '群不存在' });
    // 身份已经过 IP 验证，成员资格必须校验（不再允许“不带 userId 绕过”）
    if (!GroupModel.getMemberRole(groupId, userId)) {
      return res.status(403).json({ error: '你不是该群成员' });
    }
    const members = GroupModel.getMembers(groupId);
    res.json({ group, members });
  } catch (err) {
    logger.error(`获取群信息失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireOwnership((req) => req.query.userId), (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const userId = req.authUserId;
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });

    const result = GroupModel.deleteGroup(groupId, userId);
    if (result === null) return res.status(403).json({ error: '只有群创建者才能删除群聊' });
    res.json({ success: true });
  } catch (err) {
    logger.error(`删除群聊失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/announcement', requireOwnership((req) => req.body.userId), (req, res) => {
  try {
    const { groupId, userId, announcement } = req.body;
    if (!groupId || !userId) return res.status(400).json({ error: '缺少参数' });
    // L3：类型校验，避免非字符串写入时 SQLite 绑定异常（500）
    if (announcement !== undefined && announcement !== null && typeof announcement !== 'string') {
      return res.status(400).json({ error: '公告格式不正确' });
    }
    if (announcement && announcement.length > ANNOUNCEMENT_MAX) {
      return res.status(400).json({ error: `公告不能超过 ${ANNOUNCEMENT_MAX} 个字符` });
    }

    const group = GroupModel.setAnnouncement(groupId, userId, announcement || '');
    if (!group) return res.status(403).json({ error: '只有群创建者才能设置公告' });
    res.json({ group });
  } catch (err) {
    logger.error(`设置群公告失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/transfer-admin', requireOwnership((req) => req.body.fromUserId), (req, res) => {
  try {
    const { groupId, fromUserId, toUserId } = req.body;
    if (!groupId || !fromUserId || !toUserId) return res.status(400).json({ error: '缺少参数' });

    const group = GroupModel.transferAdmin(groupId, fromUserId, toUserId);
    if (!group) return res.status(403).json({ error: '无法转让管理员权限（仅群创建者可转让给群成员）' });
    res.json({ group });
  } catch (err) {
    logger.error(`转移管理员失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/toggle-mute', requireOwnership((req) => req.body.userId), (req, res) => {
  try {
    const { userId, groupId } = req.body;
    if (!userId || !groupId) return res.status(400).json({ error: '缺少参数' });
    if (!GroupModel.getMemberRole(groupId, userId)) {
      return res.status(403).json({ error: '你不是该群成员' });
    }
    const muted = GroupModel.toggleMute(userId, groupId);
    res.json({ muted });
  } catch (err) {
    logger.error(`切换免打扰失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/muted', requireOwnership((req) => req.query.userId), (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const userId = req.authUserId;
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    if (!GroupModel.getMemberRole(groupId, userId)) {
      return res.status(403).json({ error: '你不是该群成员' });
    }
    const muted = GroupModel.isMuted(userId, groupId);
    res.json({ muted });
  } catch (err) {
    logger.error(`查询免打扰状态失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
