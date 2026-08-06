const express = require('express');
const MessageModel = require('../models/message');
const GroupModel = require('../models/group');
const { requireOwnership } = require('../middleware/auth');
const logger = require('../logger');

const router = express.Router();
const HISTORY_LIMIT_MAX = 200;

router.post('/recall', requireOwnership((req) => req.body.userId), (req, res) => {
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
    const userId = parseInt(req.query.userId);
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    // 只能查看自己参与的对话
    if (userId !== user1 && userId !== user2) {
      return res.status(403).json({ error: '无权查看该对话' });
    }
    const limit = Math.min(parseInt(req.query.limit) || 100, HISTORY_LIMIT_MAX);
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
    const userId = parseInt(req.query.userId);
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    if (!GroupModel.getMemberRole(groupId, userId)) {
      return res.status(403).json({ error: '你不是该群成员' });
    }
    const limit = Math.min(parseInt(req.query.limit) || 100, HISTORY_LIMIT_MAX);
    const offset = parseInt(req.query.offset) || 0;

    const messages = MessageModel.getGroupHistory(groupId, limit, offset);
    res.json(messages);
  } catch (err) {
    logger.error(`获取群聊历史失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
