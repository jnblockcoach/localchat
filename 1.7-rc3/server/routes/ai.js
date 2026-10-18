// AI 助理管理路由：检测本机 OpenClaw、手工注册 AI 助理
const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const UserModel = require('../models/user');
const FriendModel = require('../models/friend');
const { requireOwnership, normalizeIp, isLocalIp } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { stripControlSingleLine } = require('../sanitize');
const { getDb } = require('../db');
const { clients } = require('../websocket');
const logger = require('../logger');

const router = express.Router();
const OPENCLAW_PORT = 18789;
const USERNAME_MAX = 20;

// L10：目标 IP 必须是合法 IPv4/IPv6（防止任意字符串写入 ai_peers 并回显到三端）
function isValidIp(ip) {
  return net.isIPv4(ip) || net.isIPv6(ip);
}

// IPv6 拼 URL 需要方括号
function wsHostFor(ip) {
  return net.isIPv6(ip) ? `[${ip}]` : ip;
}

// M5：AI 助理注册仅限服务器本机（OpenClaw 探针也只检查本机）
function requireLocalIp(req, res, next) {
  if (!isLocalIp(req.ip)) {
    return res.status(403).json({ error: '只有服务器本机可以注册 AI 助理' });
  }
  next();
}

// 检测本机是否运行着 OpenClaw Gateway（WS 连接探测；L-c/R9：正负结果均缓存 5 秒）
let ocProbeCache = { at: 0, result: null };
function detectOpenClaw() {
  const now = Date.now();
  if (ocProbeCache.result !== null && now - ocProbeCache.at < 5000) {
    return Promise.resolve(ocProbeCache.result);
  }
  return new Promise((resolve) => {
    let ws;
    const done = (running) => {
      try { if (ws) ws.terminate(); } catch {}
      const result = { running: !!running };
      ocProbeCache = { at: Date.now(), result };
      resolve(result);
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
  if (!account) return false; // H1：未注册 AI 时不允许查看 workspace
  if (!userId) return false;
  const rel = FriendModel.getRelationship(parseInt(userId), account.id);
  return !!(rel && rel.status === 'accepted');
}

// AI 是否已注册（status 的注册流程需要）
function aiRegistered() {
  return !!UserModel.findAiAccount();
}

// 状态：OpenClaw 运行情况 + 已注册的 AI 助理账号（登录可见；已注册时需 AI 好友）
router.get('/status', requireOwnership((req) => req.query.userId), (req, res) => {
  try {
    const account = UserModel.findAiAccount();
    // H1：本机请求（插件发现 AI 账号）免登录可见；远端必须是 AI 好友
    if (account && !isLocalIp(req.ip) && !canViewAi(req.authUserId)) {
      return res.status(403).json({ error: '请先添加 AI 助理为好友' });
    }
    // F8：未注册 AI 时，远端不泄露本机 OpenClaw 运行状态
    if (!account && !isLocalIp(req.ip)) {
      return res.json({ openclaw: null, account: null });
    }
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
router.post('/register', requireLocalIp, rateLimit({ windowMs: 60000, max: 5, message: 'AI 注册过于频繁，请稍后再试' }), requireOwnership((req) => req.body.registrantId), async (req, res) => {
  try {
    const { username, registrantId } = req.body;
    // R7：单行字段去除控制字符
    const name = typeof username === 'string' ? stripControlSingleLine(username) : '';
    if (!name) {
      return res.status(400).json({ error: '请输入 AI 助理名称' });
    }
    if (name.length > USERNAME_MAX) {
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
      user = UserModel.createAi(normalizeIp(req.ip), name);
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
    // 鉴权：仅 AI 好友可查看（H1：未注册 AI 时也拒绝）
    if (!canViewAi(req.authUserId)) {
      return res.status(403).json({ error: aiRegistered() ? '请先添加 AI 助理为好友后再查看 Workspace' : '尚未注册 AI 助理' });
    }
    const file = req.query.file;
    if (!file) {
      // 列出 workspace 文件（R20：lstat 拒绝符号链接，防止借软链读取外部文件）
      let files = [];
      try {
        for (const f of fs.readdirSync(WORKSPACE_DIR)) {
          const p = path.join(WORKSPACE_DIR, f);
          const stat = fs.lstatSync(p);
          if (stat.isFile()) {
            files.push({ name: f, size: stat.size, mtime: stat.mtimeMs });
          }
        }
      } catch {
        return res.json({ files: [], error: 'AI workspace 不存在（OpenClaw 未初始化？）' });
      }
      return res.json({ files });
    }

    // 读取单个文件（防目录穿越：仅取文件名；R20：lstat 拒绝符号链接）
    const safe = path.basename(String(file));
    const p = path.join(WORKSPACE_DIR, safe);
    let stat;
    try {
      stat = fs.lstatSync(p);
    } catch {
      return res.status(404).json({ error: '文件不存在' });
    }
    if (!stat.isFile()) {
      return res.status(404).json({ error: '文件不存在' });
    }
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
      ws = new WebSocket(`ws://${wsHostFor(targetIp)}:${OPENCLAW_PORT}`, { handshakeTimeout: 2000 });
      ws.on('open', () => done(true));
      ws.on('error', (e) => {
        const msg = (e && e.message) || '';
        // 仅连接被拒绝类错误视为"未运行"；超时/网络不可达等其他错误保守视为不可用
        const notRunning = /ECONNREFUSED|ENOTFOUND|EADDRNOTAVAIL|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN/.test(msg);
        done(!notRunning);
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
    const { targetIp, token } = req.body;
    if (!targetIp) return res.status(400).json({ error: '请输入目标机器 IP' });
    const ip = normalizeIp(targetIp);
    if (!isValidIp(ip)) return res.status(400).json({ error: '目标 IP 格式不正确' });

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

    // 已存在连接/请求（L1：超过 7 天的 pending 允许重新发起）
    const existing = getDb().prepare('SELECT * FROM ai_peers WHERE ip = ?').get(ip);
    if (existing) {
      if (existing.status === 'accepted') {
        return res.status(400).json({ error: '已与该机器互联' });
      }
      const ageMs = Date.now() - new Date(existing.created_at + 'Z').getTime();
      if (ageMs < 7 * 86400000) {
        return res.status(400).json({ error: '已向该机器发起请求，等待对方确认' });
      }
      // 过期重新发起：更新时间与 token
      getDb().prepare("UPDATE ai_peers SET created_at = datetime('now'), token = ? WHERE id = ?").run(String(token || '').trim() || null, existing.id);
      logger.info(`OpenClaw 互联请求重新发起: ${ip}`);
      notifyIpAccounts(ip, { type: 'openclaw_request', fromIp: normalizeIp(req.ip), targetIp: ip });
      return res.json({ success: true, message: `已重新向 ${ip} 发送 OpenClaw 互联请求` });
    }

    getDb().prepare("INSERT INTO ai_peers (ip, status, token) VALUES (?, 'pending', ?)").run(ip, String(token || '').trim() || null);
    logger.info(`OpenClaw 互联请求: 本机 -> ${ip} (token=${token ? '已提供' : '未提供'})`);

    // 通知对方 IP 的所有在线账号（与好友请求同等级）
    notifyIpAccounts(ip, { type: 'openclaw_request', fromIp: normalizeIp(req.ip), targetIp: ip });

    res.json({ success: true, message: `已向 ${ip} 发送 OpenClaw 互联请求` });
  } catch (err) {
    logger.error(`互联请求失败: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 互联列表（L2：本机免登录供插件使用；R24：远程需登录且为 AI 好友）
router.get('/peers', (req, res) => {
  try {
    if (!isLocalIp(req.ip)) {
      const userId = parseInt(req.query.userId);
      if (!userId) return res.status(400).json({ error: '缺少用户ID' });
      const user = UserModel.findById(userId);
      if (!user) return res.status(404).json({ error: '用户不存在' });
      if (normalizeIp(req.ip) !== user.ip) {
        return res.status(403).json({ error: '身份验证失败' });
      }
      // R24：互联拓扑仅对 AI 好友可见
      if (!canViewAi(userId)) {
        return res.status(403).json({ error: aiRegistered() ? '请先添加 AI 助理为好友' : '尚未注册 AI 助理' });
      }
    }
    const peers = getAiPeers();
    const localReq = isLocalIp(req.ip);
    const safePeers = localReq
      ? peers
      : peers.map((p) => { const { token, ...rest } = p; return rest; });
    res.json({ peers: safePeers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 对方确认互联（操作者须为目标 IP 的账号；确认后该 IP 所有账号的请求消除）
router.post('/interconnect/accept', requireOwnership((req) => req.body.userId), (req, res) => {
  try {
    const { targetIp, userId } = req.body;
    const ip = normalizeIp(targetIp);
    if (!isValidIp(ip)) return res.status(400).json({ error: '目标 IP 格式不正确' });
    const user = require('../models/user').findById(parseInt(userId));
    if (!user) return res.status(404).json({ error: '用户不存在' });

    // M7：只有目标 IP 的账号可以确认（本机目标由本机账号确认）
    if (user.ip !== ip) {
      return res.status(403).json({ error: '只有该机器的用户才能确认互联' });
    }

    // M4：全局最多一个已生效互联
    const existingAccepted = getDb().prepare("SELECT * FROM ai_peers WHERE status = 'accepted' AND ip != ?").get(ip);
    if (existingAccepted) {
      return res.status(400).json({ error: `已有生效互联（${existingAccepted.ip}），请先断开再接受新的` });
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

// 拒绝互联（R4：只有目标 IP 的账号可操作）
router.post('/interconnect/reject', requireOwnership((req) => req.body.userId), (req, res) => {
  try {
    const { targetIp, userId } = req.body;
    const ip = normalizeIp(targetIp);
    if (!isValidIp(ip)) return res.status(400).json({ error: '目标 IP 格式不正确' });
    const user = UserModel.findById(parseInt(userId));
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (normalizeIp(user.ip) !== ip) {
      return res.status(403).json({ error: '只有该机器的用户才能拒绝互联' });
    }
    // M4：全局最多一个已生效互联
    const existingAccepted = getDb().prepare("SELECT * FROM ai_peers WHERE status = 'accepted' AND ip != ?").get(ip);
    if (existingAccepted) {
      return res.status(400).json({ error: `已有生效互联（${existingAccepted.ip}），请先断开再接受新的` });
    }
    const peer = getDb().prepare('SELECT * FROM ai_peers WHERE ip = ? AND status = ?').get(ip, 'pending');
    if (!peer) return res.status(404).json({ error: '没有待确认的互联请求' });
    getDb().prepare('DELETE FROM ai_peers WHERE id = ?').run(peer.id);
    notifyIpAccounts(ip, { type: 'openclaw_request_handled', targetIp: ip, status: 'rejected' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// M5：断开互联（删除 peer 记录，插件轮询检测后回退本机）
// R4：只有目标 IP 的账号可操作
router.post('/interconnect/disconnect', requireOwnership((req) => req.body.userId), (req, res) => {
  try {
    const { targetIp, userId } = req.body;
    const ip = normalizeIp(targetIp);
    if (!isValidIp(ip)) return res.status(400).json({ error: '目标 IP 格式不正确' });
    const user = UserModel.findById(parseInt(userId));
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (normalizeIp(user.ip) !== ip) {
      return res.status(403).json({ error: '只有该机器的用户才能断开互联' });
    }
    const peer = getDb().prepare('SELECT * FROM ai_peers WHERE ip = ? AND status = ?').get(ip, 'accepted');
    if (!peer) return res.status(404).json({ error: '没有已生效的互联' });
    getDb().prepare('DELETE FROM ai_peers WHERE id = ?').run(peer.id);
    logger.info(`OpenClaw 互联已断开: ${ip}`);
    notifyIpAccounts(ip, { type: 'openclaw_request_handled', targetIp: ip, status: 'disconnected' });
    res.json({ success: true, message: `已断开与 ${ip} 的互联` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
