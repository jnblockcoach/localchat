const express = require('express');
const BlockModel = require('../models/block');
const logger = require('../logger');

const router = express.Router();

router.post('/block', (req, res) => {
  try {
    const { userId, blockedUserId } = req.body;
    if (!userId || !blockedUserId) {
      return res.status(400).json({ error: '缺少参数' });
    }
    if (Number(userId) === Number(blockedUserId)) {
      return res.status(400).json({ error: '不能拉黑自己' });
    }
    BlockModel.block(userId, blockedUserId);
    res.json({ success: true });
  } catch (err) {
    logger.error(`拉黑失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/unblock', (req, res) => {
  try {
    const { userId, blockedUserId } = req.body;
    if (!userId || !blockedUserId) {
      return res.status(400).json({ error: '缺少参数' });
    }
    BlockModel.unblock(userId, blockedUserId);
    res.json({ success: true });
  } catch (err) {
    logger.error(`取消拉黑失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  try {
    const userId = parseInt(req.query.userId);
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    const blocked = BlockModel.getBlockedUsers(userId);
    res.json(blocked);
  } catch (err) {
    logger.error(`获取黑名单失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
