const express = require('express');
const FriendModel = require('../models/friend');
const UserModel = require('../models/user');
const { notifyFriendRequest, notifyRequestHandled, notifyNewFriend } = require('../websocket');
const logger = require('../logger');

const router = express.Router();

router.post('/add', (req, res) => {
  try {
    const { userId, friendId } = req.body;
    if (!userId || !friendId) {
      return res.status(400).json({ error: '缺少参数' });
    }
    if (Number(userId) === Number(friendId)) {
      return res.status(400).json({ error: '不能添加自己为好友' });
    }

    const existing = FriendModel.getRelationship(userId, friendId);
    if (existing) {
      return res.status(400).json({ error: '已存在好友或请求关系' });
    }

    const result = FriendModel.sendRequest(userId, friendId);
    const friend = UserModel.findById(friendId);
    notifyFriendRequest(userId, friendId);
    res.json({ request: result, friend });
  } catch (err) {
    logger.error(`添加好友失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/accept', (req, res) => {
  try {
    const { userId, friendId } = req.body;
    if (!userId || !friendId) {
      return res.status(400).json({ error: '缺少参数' });
    }

    const result = FriendModel.acceptRequest(userId, friendId);
    if (!result) {
      return res.status(404).json({ error: '未找到好友请求' });
    }

    const friend = UserModel.findById(friendId);
    notifyRequestHandled(friendId, userId, 'accepted');
    notifyNewFriend(userId, friendId);
    notifyNewFriend(friendId, userId);
    res.json({ result, friend });
  } catch (err) {
    logger.error(`接受好友请求失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  try {
    const userId = parseInt(req.query.userId);
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    const friends = FriendModel.getFriends(userId);
    res.json(friends);
  } catch (err) {
    logger.error(`获取好友列表失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/pending', (req, res) => {
  try {
    const userId = parseInt(req.query.userId);
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    const requests = FriendModel.getPendingRequests(userId);
    res.json(requests);
  } catch (err) {
    logger.error(`获取待处理请求失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/sent', (req, res) => {
  try {
    const userId = parseInt(req.query.userId);
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });
    const requests = FriendModel.getSentRequests(userId);
    res.json(requests);
  } catch (err) {
    logger.error(`获取已发送请求失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/', (req, res) => {
  try {
    const { userId, friendId } = req.body;
    if (!userId || !friendId) {
      return res.status(400).json({ error: '缺少参数' });
    }
    FriendModel.deleteFriend(userId, friendId);
    res.json({ success: true });
  } catch (err) {
    logger.error(`删除好友失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
