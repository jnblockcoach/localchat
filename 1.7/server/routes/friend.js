const express = require('express');
const FriendModel = require('../models/friend');
const UserModel = require('../models/user');
const { notifyFriendRequest, notifyRequestHandled, notifyNewFriend, notifyFriendRemoved } = require('../websocket');
const { requireOwnership } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { parseId } = require('../util/parse');
const logger = require('../logger');

const router = express.Router();

router.post('/add', rateLimit({ windowMs: 60000, max: 30, message: '好友请求过于频繁，请稍后再试' }), requireOwnership((req) => req.body.userId), (req, res) => {
  try {
    const { userId, friendId } = req.body;
    if (!userId || !friendId) {
      return res.status(400).json({ error: '缺少参数' });
    }
    // K1：目标 ID 合法且存在，避免 FK 约束导致 500
    const targetId = parseId(friendId);
    if (!targetId) {
      return res.status(400).json({ error: '参数不合法' });
    }
    if (Number(userId) === targetId) {
      return res.status(400).json({ error: '不能添加自己为好友' });
    }

    const target = UserModel.findById(targetId);
    if (!target) {
      return res.status(404).json({ error: '用户不存在' });
    }

    // 目标是 AI 助理账号：直接建立好友关系（无需等待对方接受）
    if (target.is_ai) {
      FriendModel.autoFriend(userId, targetId);
      return res.json({ request: { status: 'accepted' }, friend: target });
    }

    const existing = FriendModel.getRelationship(userId, targetId);
    if (existing) {
      return res.status(400).json({ error: '已存在好友或请求关系' });
    }

    const result = FriendModel.sendRequest(userId, targetId);
    notifyFriendRequest(userId, targetId);
    res.json({ request: result, friend: target });
  } catch (err) {
    logger.error(`添加好友失败: ${err.message}`);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.post('/accept', requireOwnership((req) => req.body.userId), (req, res) => {
  try {
    const { userId, friendId } = req.body;
    if (!userId || !friendId) {
      return res.status(400).json({ error: '缺少参数' });
    }
    // K1：严格 ID（不存在的请求由模型层返回 404）
    const requesterId = parseId(friendId);
    if (!requesterId) {
      return res.status(400).json({ error: '参数不合法' });
    }

    const result = FriendModel.acceptRequest(userId, requesterId);
    if (!result) {
      return res.status(404).json({ error: '未找到好友请求' });
    }

    const friend = UserModel.findById(requesterId);
    notifyRequestHandled(requesterId, userId, 'accepted');
    notifyNewFriend(userId, requesterId);
    notifyNewFriend(requesterId, userId);
    res.json({ result, friend });
  } catch (err) {
    logger.error(`接受好友请求失败: ${err.message}`);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.post('/reject', requireOwnership((req) => req.body.userId), (req, res) => {
  try {
    const { userId, friendId } = req.body;
    if (!userId || !friendId) {
      return res.status(400).json({ error: '缺少参数' });
    }
    // K1：严格 ID
    const requesterId = parseId(friendId);
    if (!requesterId) {
      return res.status(400).json({ error: '参数不合法' });
    }

    const ok = FriendModel.rejectRequest(userId, requesterId);
    if (!ok) {
      return res.status(404).json({ error: '未找到好友请求' });
    }

    // 通知请求方：请求已被拒绝
    notifyRequestHandled(requesterId, userId, 'rejected');
    res.json({ success: true });
  } catch (err) {
    logger.error(`拒绝好友请求失败: ${err.message}`);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/', requireOwnership((req) => req.query.userId), (req, res) => {
  try {
    const userId = req.authUserId;
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    const friends = FriendModel.getFriends(userId);
    res.json(friends);
  } catch (err) {
    logger.error(`获取好友列表失败: ${err.message}`);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/pending', requireOwnership((req) => req.query.userId), (req, res) => {
  try {
    const userId = req.authUserId;
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    const requests = FriendModel.getPendingRequests(userId);
    res.json(requests);
  } catch (err) {
    logger.error(`获取待处理请求失败: ${err.message}`);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/sent', requireOwnership((req) => req.query.userId), (req, res) => {
  try {
    const userId = req.authUserId;
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    const requests = FriendModel.getSentRequests(userId);
    res.json(requests);
  } catch (err) {
    logger.error(`获取已发送请求失败: ${err.message}`);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.delete('/', requireOwnership((req) => req.body.userId), (req, res) => {
  try {
    const { userId, friendId } = req.body;
    if (!userId || !friendId) {
      return res.status(400).json({ error: '缺少参数' });
    }
    // K2：严格 ID，避免对象/数组直达 SQL 绑定导致 500
    const targetId = parseId(friendId);
    if (!targetId) {
      return res.status(400).json({ error: '参数不合法' });
    }
    FriendModel.deleteFriend(userId, targetId);
    // 实时通知对方：好友关系已解除
    notifyFriendRemoved(userId, targetId);
    res.json({ success: true });
  } catch (err) {
    logger.error(`删除好友失败: ${err.message}`);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
