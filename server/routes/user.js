const express = require('express');
const UserModel = require('../models/user');
const { clients } = require('../websocket');
const logger = require('../logger');

const router = express.Router();

router.post('/register', (req, res) => {
  logger.info(`注册请求: ip=${req.ip} username=${req.body.username}`);
  try {
    const { username } = req.body;
    if (!username || !username.trim()) {
      return res.status(400).json({ error: '用户名不能为空' });
    }

    const user = UserModel.create(req.ip, username.trim());
    res.json({ user });
  } catch (err) {
    logger.error(`注册失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/login', (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: '缺少用户ID' });

    const user = UserModel.findById(parseInt(id));
    if (!user) return res.status(404).json({ error: '用户不存在' });

    logger.info(`用户登录: id=${user.id} username=${user.username}`);
    res.json({ user });
  } catch (err) {
    logger.error(`登录失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/by-ip', (req, res) => {
  try {
    const ip = req.ip;
    const users = UserModel.findByIp(ip);
    res.json(users);
  } catch (err) {
    logger.error(`获取IP用户列表失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.put('/update', (req, res) => {
  try {
    const { id, username } = req.body;
    if (!id) return res.status(400).json({ error: '缺少用户ID' });
    if (!username || !username.trim()) return res.status(400).json({ error: '用户名不能为空' });

    const user = UserModel.updateUsername(id, username.trim());
    if (!user) return res.status(404).json({ error: '用户不存在' });
    res.json(user);
  } catch (err) {
    logger.error(`修改用户名失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/search', (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !q.trim()) {
      return res.json([]);
    }
    const users = UserModel.search(q.trim());
    res.json(users);
  } catch (err) {
    logger.error(`搜索用户失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', (req, res) => {
  try {
    const id = parseInt(req.query.id);
    if (!id) return res.status(400).json({ error: '缺少用户ID' });
    const user = UserModel.findById(id);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    res.json(user);
  } catch (err) {
    logger.error(`获取用户信息失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/online', (req, res) => {
  try {
    const userIds = Array.from(clients.keys());
    const users = userIds.map((id) => UserModel.findById(id)).filter(Boolean);
    res.json(users);
  } catch (err) {
    logger.error(`获取在线用户失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/all', (req, res) => {
  try {
    const users = UserModel.getAllUsers();
    res.json(users);
  } catch (err) {
    logger.error(`获取所有用户失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
