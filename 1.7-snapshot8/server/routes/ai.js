// AI 助理管理路由：检测本机 OpenClaw、手工注册 AI 助理
const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const UserModel = require('../models/user');
const FriendModel = require('../models/friend');
const { requireOwnership, normalizeIp, isLocalIp } = require('../middleware/auth');
const FriendModel2 = require('../models/friend');
const { getDb } = require('../db');
const { clients } = require('../websocket');
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

// 校验请求者是否有权查看 AI 相关（status/workspace）：AI 已注册且请求者是 AI 好友
function canViewAi(userId) {
  const account = UserModel.findAiAccount();
  if (!account) return true; // 未注册时允许查看（用于注册流程）
  if (!userId) return false;
  const rel = FriendModel.getRelationship(parseInt(userId), account.id);
  return !!(rel && rel.status === 'accepted');
}

// 状态：OpenClaw 运行情况 + 已注册的 AI 助理账号（登录用户可见，注册流程需要）
router.get('/status', requireOwnership((req) => req.query.userId), (req, res) => {
  try {
    const account = UserModel.findAiAccount();
    const openclawPromise = detectOpenClaw();
    openclawPromise.then((openclaw) => {
      const acc = account ? { ...account } : null;
      if (acc) acc.ip_index = UserModel.getAccountIndex(acc.ip, acc.id);
      res.json({ openclaw, account: acc });
    }).catch((err) => {
      logger.error(`AI 状态查询失败: ${err.message}`);
      res.status(500).json({ error: err.message });
    });
  } catch (err) {
    logger.error(`AI 状态查询失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 手工注册 AI 助理（名称自定义；registrantId 提供时自动与其建立好友关系）
router.post('/register', requireOwnership((req) => req.body.registrantId), async (req, res) => {
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

// AI workspace 查看（只读）：列出文件 / 查看文本内容
const WORKSPACE_DIR = path.join(os.homedir(), '.openclaw', 'workspace');
const TEXT_EXTS = ['.md', '.txt', '.json', '.json5', '.yml', '.yaml', '.toml', '.sh', '.js', '.py'];

router.get('/workspace', requireOwnership((req) => req.query.userId), (req, res) => {
  try {
    // 鉴权：AI 已注册时，仅 AI 好友可查看（H2 修复）
    const account = UserModel.findAiAccount();
    if (account && !canViewAi(req.query.userId)) {
      return res.status(403).json({ error: '请先添加 AI 助理为好友后再查看 Workspace' });
    }
    const file = req.query.file;
    if (!file) {
      // 列出 workspace 文件
      let files = [];
      try {
        for (const f of fs.readdirSync(WORKSPACE_DIR)) {
          const p = path.join(WORKSPACE_DIR, f);
          const stat = fs.statSync(p);
          if (stat.isFile()) {
            files.push({ name: f, size: stat.size, mtime: stat.mtimeMs });
          }
        }
      } catch {
        return res.json({ files: [], error: 'AI workspace 不存在（OpenClaw 未初始化？）' });
      }
      return res.json({ files });
    }

    // 读取单个文件（防目录穿越：仅取文件名）
    const safe = path.basename(String(file));
    const p = path.join(WORKSPACE_DIR, safe);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      return res.status(404).json({ error: '文件不存在' });
    }
    const stat = fs.statSync(p);
    if (stat.size > 200 * 1024) {
      return res.status(400).json({ error: '文件过大，请直接查看 OpenClaw 目录' });
    }
    const ext = path.extname(safe).toLowerCase();
    if (!TEXT_EXTS.includes(ext)) {
      return res.status(400).json({ error: '不支持预览该文件类型' });
    }
    return res.json({ name: safe, content: fs.readFileSync(p, 'utf8') });
  } catch (err) {
    logger.error(`AI workspace 查看失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ===== 机器互联 OpenClaw =====

// 探测目标机器的 OpenClaw（targetIp:18789 WS 探测）
function probeOpenClaw(targetIp) {
  return new Promise((resolve) => {
    let ws;
    const done = (running) => { try { if (ws) ws.terminate(); } catch {} resolve(!!running); };
    try {
      ws = new WebSocket(`ws://${targetIp}:${OPENCLAW_PORT}`, { handshakeTimeout: 2000 });
      ws.on('open', () => done(true));
      ws.on('error', (e) => {
        const msg = (e && e.message) || '';
        done(!/ECONNREFUSED|ENOTFOUND|EADDRNOTAVAIL/.test(msg));
      });
      setTimeout(() => done(false), 3000);
    } catch { done(false); }
  });
}

function getAiPeers() {
  return getDb().prepare('SELECT * FROM ai_peers ORDER BY id ASC').all();
}

// 通知某 IP 的所有在线账号（openclaw_request 事件）
function notifyIpAccounts(ip, payload) {
  const users = getDb().prepare('SELECT id FROM users WHERE ip = ?').all(ip);
  for (const u of users) {
    const ws = clients.get(Number(u.id));
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
    }
  }
}

// 发起互联：仅服务器本机用户可发起（连接哪台机器的 OpenClaw 由服务器所有者决定）
router.post('/interconnect', (req, res, next) => {
  if (!isLocalIp(req.ip)) {
    return res.status(403).json({ error: '只有服务器本机可以发起 OpenClaw 互联' });
  }
  next();
}, async (req, res) => {
  try {
    const { targetIp } = req.body;
    if (!targetIp) return res.status(400).json({ error: '请输入目标机器 IP' });
    const ip = normalizeIp(targetIp);

    // 对方必须有用户账号（服务器上该 IP 注册过）
    const hasAccount = getDb().prepare('SELECT COUNT(*) as c FROM users WHERE ip = ?').get(ip);
    if (!hasAccount || hasAccount.c === 0) {
      return res.status(400).json({ error: `对方（${ip}）没有用户账号，无法接收确认请求` });
    }

    // 对方必须运行 OpenClaw
    const ocRunning = await probeOpenClaw(ip);
    if (!ocRunning) {
      return res.status(400).json({ error: `对方（${ip}）未运行 OpenClaw 服务` });
    }

    // 已存在连接/请求
    const existing = getDb().prepare('SELECT * FROM ai_peers WHERE ip = ?').get(ip);
    if (existing) {
      return res.status(400).json({ error: existing.status === 'accepted' ? '已与该机器互联' : '已向该机器发起请求，等待对方确认' });
    }

    getDb().prepare("INSERT INTO ai_peers (ip, status) VALUES (?, 'pending')").run(ip);
    logger.info(`OpenClaw 互联请求: 本机 -> ${ip}`);

    // 通知对方 IP 的所有在线账号（与好友请求同等级）
    notifyIpAccounts(ip, { type: 'openclaw_request', fromIp: normalizeIp(req.ip), targetIp: ip });

    res.json({ success: true, message: `已向 ${ip} 发送 OpenClaw 互联请求` });
  } catch (err) {
    logger.error(`互联请求失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 互联列表
router.get('/peers', (req, res) => {
  try {
    const peers = getAiPeers();
    res.json({ peers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 对方确认互联（操作者须为目标 IP 的账号；确认后该 IP 所有账号的请求消除）
router.post('/interconnect/accept', requireOwnership((req) => req.body.userId), (req, res) => {
  try {
    const { targetIp, userId } = req.body;
    const ip = normalizeIp(targetIp);
    const user = require('../models/user').findById(parseInt(userId));
    if (!user) return res.status(404).json({ error: '用户不存在' });

    // 只有目标 IP 的账号（或服务器本机）可以确认
    const myIp = normalizeIp(req.ip);
    if (!(user.ip === ip || (isLocalIp(myIp) && user.ip === myIp))) {
      return res.status(403).json({ error: '只有该机器的用户才能确认互联' });
    }

    const peer = getDb().prepare('SELECT * FROM ai_peers WHERE ip = ? AND status = ?').get(ip, 'pending');
    if (!peer) return res.status(404).json({ error: '没有待确认的互联请求' });

    getDb().prepare("UPDATE ai_peers SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?").run(peer.id);
    logger.info(`OpenClaw 互联已确认: ${ip} by userId=${userId}`);

    // 对方 IP 所有账号的请求消除（状态已更新，客户端刷新后消失）
    notifyIpAccounts(ip, { type: 'openclaw_request_handled', targetIp: ip, status: 'accepted' });

    res.json({ success: true, message: `已确认与 ${ip} 的 OpenClaw 互联` });
  } catch (err) {
    logger.error(`确认互联失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 拒绝互联
router.post('/interconnect/reject', requireOwnership((req) => req.body.userId), (req, res) => {
  try {
    const { targetIp } = req.body;
    const ip = normalizeIp(targetIp);
    const peer = getDb().prepare('SELECT * FROM ai_peers WHERE ip = ? AND status = ?').get(ip, 'pending');
    if (!peer) return res.status(404).json({ error: '没有待确认的互联请求' });
    getDb().prepare('DELETE FROM ai_peers WHERE id = ?').run(peer.id);
    notifyIpAccounts(ip, { type: 'openclaw_request_handled', targetIp: ip, status: 'rejected' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
