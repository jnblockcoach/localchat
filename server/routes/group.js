const express = require('express');
const GroupModel = require('../models/group');
const logger = require('../logger');

const router = express.Router();

router.post('/create', (req, res) => {
  try {
    const { name, creatorId, memberIds } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: '群名称不能为空' });
    }
    if (!creatorId) {
      return res.status(400).json({ error: '缺少创建者ID' });
    }

    const group = GroupModel.create(name.trim(), creatorId, memberIds || []);
    const members = GroupModel.getMembers(group.id);
    res.json({ group, members });
  } catch (err) {
    logger.error(`创建群聊失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/add-member', (req, res) => {
  try {
    const { groupId, userId } = req.body;
    if (!groupId || !userId) {
      return res.status(400).json({ error: '缺少参数' });
    }
    GroupModel.addMember(groupId, userId);
    const members = GroupModel.getMembers(groupId);
    res.json({ members });
  } catch (err) {
    logger.error(`添加群成员失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/remove-member', (req, res) => {
  try {
    const { groupId, userId } = req.body;
    if (!groupId || !userId) {
      return res.status(400).json({ error: '缺少参数' });
    }
    GroupModel.removeMember(groupId, userId);
    const members = GroupModel.getMembers(groupId);
    res.json({ members });
  } catch (err) {
    logger.error(`移除群成员失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  try {
    const userId = parseInt(req.query.userId);
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    const groups = GroupModel.getUserGroups(userId);
    res.json(groups);
  } catch (err) {
    logger.error(`获取用户群聊失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/members', (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const members = GroupModel.getMembers(groupId);
    res.json(members);
  } catch (err) {
    logger.error(`获取群成员失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const group = GroupModel.getById(groupId);
    if (!group) return res.status(404).json({ error: '群不存在' });
    const members = GroupModel.getMembers(groupId);
    res.json({ group, members });
  } catch (err) {
    logger.error(`获取群信息失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const userId = parseInt(req.query.userId);
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });

    const result = GroupModel.deleteGroup(groupId, userId);
    if (result === null) return res.status(403).json({ error: '只有群创建者才能删除群聊' });
    res.json({ success: true });
  } catch (err) {
    logger.error(`删除群聊失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/announcement', (req, res) => {
  try {
    const { groupId, userId, announcement } = req.body;
    if (!groupId || !userId) return res.status(400).json({ error: '缺少参数' });

    const group = GroupModel.setAnnouncement(groupId, userId, announcement || '');
    if (!group) return res.status(403).json({ error: '只有群创建者才能设置公告' });
    res.json({ group });
  } catch (err) {
    logger.error(`设置群公告失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/transfer-admin', (req, res) => {
  try {
    const { groupId, fromUserId, toUserId } = req.body;
    if (!groupId || !fromUserId || !toUserId) return res.status(400).json({ error: '缺少参数' });

    const group = GroupModel.transferAdmin(groupId, fromUserId, toUserId);
    if (!group) return res.status(403).json({ error: '只有群创建者才能转移管理员权限' });
    res.json({ group });
  } catch (err) {
    logger.error(`转移管理员失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/toggle-mute', (req, res) => {
  try {
    const { userId, groupId } = req.body;
    if (!userId || !groupId) return res.status(400).json({ error: '缺少参数' });
    const muted = GroupModel.toggleMute(userId, groupId);
    res.json({ muted });
  } catch (err) {
    logger.error(`切换免打扰失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/muted', (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const userId = parseInt(req.query.userId);
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    const muted = GroupModel.isMuted(userId, groupId);
    res.json({ muted });
  } catch (err) {
    logger.error(`查询免打扰状态失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
