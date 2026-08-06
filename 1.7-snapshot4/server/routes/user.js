const express = require('express');
const UserModel = require('../models/user');
const { clients } = require('../websocket');
const logger = require('../logger');

const router = express.Router();

const USERNAME_MAX = 20;

// 规范化客户端 IP：IPv6 映射地址 ::ffff:x.x.x.x 还原为 IPv4
function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '');
}

router.post('/register', (req, res) => {
  logger.info(`注册请求: ip=${normalizeIp(req.ip)} username=${req.body.username}`);
  try {
    const { username } = req.body;
    if (!username || !username.trim()) {
      return res.status(400).json({ error: '用户名不能为空' });
    }
    if (username.trim().length > USERNAME_MAX) {
      return res.status(400).json({ error: `用户名不能超过 ${USERNAME_MAX} 个字符` });
    }

    const ip = normalizeIp(req.ip);
    const user = UserModel.create(ip, username.trim());
    // 返回账号序号（IP-N 的 N），方便客户端显示 "IP-N"
    user.ip_index = UserModel.getAccountIndex(ip, user.id);
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

    let user = null;
    if (typeof id === 'string' && id.startsWith('openclaw-')) {
      // AI 账号独立 ID 体系：openclaw-IP-序号
      user = UserModel.findByDisplayId(id.trim());
    } else {
      user = UserModel.findById(parseInt(id));
    }
    if (!user) return res.status(404).json({ error: '用户不存在' });

    // 附带账号序号，供客户端显示
    user.ip_index = UserModel.getAccountIndex(user.ip, user.id);
    logger.info(`用户登录: id=${user.id} username=${user.username}`);
    res.json({ user });
  } catch (err) {
    logger.error(`登录失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/by-ip', (req, res) => {
  try {
    const ip = normalizeIp(req.ip);
    const users = UserModel.findByIpWithIndex(ip);
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
    if (username.trim().length > USERNAME_MAX) {
      return res.status(400).json({ error: `用户名不能超过 ${USERNAME_MAX} 个字符` });
    }

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
    // 附带账号序号（IP-N 的 N）
    user.ip_index = UserModel.getAccountIndex(user.ip, user.id);
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
