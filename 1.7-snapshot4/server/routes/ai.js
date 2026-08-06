// AI 助理管理路由：检测本机 OpenClaw、手工注册 AI 助理
const express = require('express');
const WebSocket = require('ws');
const UserModel = require('../models/user');
const FriendModel = require('../models/friend');
const logger = require('../logger');

const router = express.Router();
const OPENCLAW_PORT = 18789;
const USERNAME_MAX = 20;

// 检测本机是否运行着 OpenClaw Gateway（WS 连接探测）
function detectOpenClaw() {
  return new Promise((resolve) => {
    let ws;
    const done = (running) => {
      try { if (ws) ws.terminate(); } catch {}
      resolve({ running: !!running });
    };
    try {
      ws = new WebSocket(`ws://127.0.0.1:${OPENCLAW_PORT}`, { handshakeTimeout: 1500 });
      ws.on('open', () => done(true));
      ws.on('error', (e) => {
        // 连接被拒绝 = 未运行；其他错误（协议/认证拒绝）说明 gateway 在跑
        const msg = (e && e.message) || '';
        done(!/ECONNREFUSED|ENOTFOUND|EADDRNOTAVAIL/.test(msg));
      });
      setTimeout(() => done(false), 2500);
    } catch {
      done(false);
    }
  });
}

// 状态：OpenClaw 运行情况 + 已注册的 AI 助理账号
router.get('/status', async (req, res) => {
  try {
    const openclaw = await detectOpenClaw();
    const account = UserModel.findAiAccount();
    if (account) {
      account.ip_index = UserModel.getAccountIndex(account.ip, account.id);
    }
    res.json({ openclaw, account: account || null });
  } catch (err) {
    logger.error(`AI 状态查询失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 手工注册 AI 助理（名称自定义；registrantId 提供时自动与其建立好友关系）
router.post('/register', async (req, res) => {
  try {
    const { username, registrantId } = req.body;
    if (!username || !username.trim()) {
      return res.status(400).json({ error: '请输入 AI 助理名称' });
    }
    if (username.trim().length > USERNAME_MAX) {
      return res.status(400).json({ error: `名称不能超过 ${USERNAME_MAX} 个字符` });
    }

    const existing = UserModel.findAiAccount();
    if (existing) {
      return res.status(409).json({ error: `AI 助理已注册（${existing.username} ${existing.display_id || ('#' + existing.id)}）` });
    }

    // 校验 OpenClaw 在运行
    const openclaw = await detectOpenClaw();
    if (!openclaw.running) {
      return res.status(400).json({ error: '未检测到本机运行的 OpenClaw，请先启动' });
    }

    let user;
    try {
      user = UserModel.createAi(req.ip, username.trim());
    } catch (err) {
      // 数据库唯一索引兜底（并发/异常路径重复注册）
      const again = UserModel.findAiAccount();
      return res.status(409).json({
        error: again ? `AI 助理已注册（${again.username} ${again.display_id || ('#' + again.id)}）` : `AI 助理注册失败: ${err.message}`,
      });
    }
    user.ip_index = UserModel.getAccountIndex(user.ip, user.id);

    // 自动与当前用户建立好友关系
    if (registrantId && Number(registrantId) !== user.id) {
      FriendModel.autoFriend(registrantId, user.id);
    }

    logger.info(`AI 助理注册成功: id=${user.id} username=${user.username}`);
    res.json({ user });
  } catch (err) {
    logger.error(`AI 助理注册失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
