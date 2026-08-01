const express = require('express');
const MessageModel = require('../models/message');
const logger = require('../logger');

const router = express.Router();

router.post('/recall', (req, res) => {
  try {
    const { messageId, userId } = req.body;
    if (!messageId || !userId) {
      return res.status(400).json({ error: '缺少参数' });
    }

    const result = MessageModel.recall(messageId, userId);
    if (!result) {
      return res.status(403).json({ error: '无法撤回（超过2分钟或不是消息发送者）' });
    }
    res.json(result);
  } catch (err) {
    logger.error(`撤回消息失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/private/:user1/:user2', (req, res) => {
  try {
    const user1 = parseInt(req.params.user1);
    const user2 = parseInt(req.params.user2);
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const messages = MessageModel.getPrivateHistory(user1, user2, limit, offset);
    res.json(messages);
  } catch (err) {
    logger.error(`获取私聊历史失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/group/:groupId', (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const messages = MessageModel.getGroupHistory(groupId, limit, offset);
    res.json(messages);
  } catch (err) {
    logger.error(`获取群聊历史失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
