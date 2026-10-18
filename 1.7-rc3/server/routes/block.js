const express = require('express');
const BlockModel = require('../models/block');
const UserModel = require('../models/user');
const { requireOwnership } = require('../middleware/auth');
const { parseId } = require('../util/parse');
const logger = require('../logger');

const router = express.Router();

router.post('/block', requireOwnership((req) => req.body.userId), (req, res) => {
  try {
    const { userId, blockedUserId } = req.body;
    if (!userId || !blockedUserId) {
      return res.status(400).json({ error: '缺少参数' });
    }
    // K1：目标 ID 合法且存在，避免 FK 约束导致 500
    const targetId = parseId(blockedUserId);
    if (!targetId) {
      return res.status(400).json({ error: '参数不合法' });
    }
    if (Number(userId) === targetId) {
      return res.status(400).json({ error: '不能拉黑自己' });
    }
    if (!UserModel.findById(targetId)) {
      return res.status(404).json({ error: '用户不存在' });
    }
    BlockModel.block(userId, targetId);
    res.json({ success: true });
  } catch (err) {
    logger.error(`拉黑失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/unblock', requireOwnership((req) => req.body.userId), (req, res) => {
  try {
    const { userId, blockedUserId } = req.body;
    if (!userId || !blockedUserId) {
      return res.status(400).json({ error: '缺少参数' });
    }
    // K1：取消拉黑保持幂等，但参数必须是合法 ID
    const targetId = parseId(blockedUserId);
    if (!targetId) {
      return res.status(400).json({ error: '参数不合法' });
    }
    BlockModel.unblock(userId, targetId);
    res.json({ success: true });
  } catch (err) {
    logger.error(`取消拉黑失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', requireOwnership((req) => req.query.userId), (req, res) => {
  try {
    const userId = req.authUserId;
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    const blocked = BlockModel.getBlockedUsers(userId);
    res.json(blocked);
  } catch (err) {
    logger.error(`获取黑名单失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
