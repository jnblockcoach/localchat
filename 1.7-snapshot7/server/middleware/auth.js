// IP 身份验证：通过请求来源 IP 识别/验证身份
// 规则：账号只能由「注册 IP 相同」或「服务器本机」发起操作（服务器本机 IP 与 127.0.0.1 均视为本机）
const os = require('os');
const UserModel = require('../models/user');

function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '');
}

// 是否为服务器本机 IP（本机回环 + 本机所有网卡 IP）
function isLocalIp(ip) {
  const normalized = normalizeIp(ip);
  if (normalized === '127.0.0.1' || normalized === '::1') return true;
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal && net.address === normalized) return true;
    }
  }
  return false;
}

// 验证请求来源 IP 与账号归属一致（getUserId 从请求中提取账号 ID）
function requireOwnership(getUserId) {
  return (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) return next();
      const user = UserModel.findById(parseInt(userId));
      if (!user) return next(); // 用户不存在由业务层处理
      const ip = normalizeIp(req.ip);
      if (isLocalIp(ip) || ip === user.ip) return next();
      return res.status(403).json({ error: '身份验证失败：该账号不属于当前设备 IP' });
    } catch {
      return next();
    }
  };
}

// 校验 WS 认证来源 IP
function verifyAuthIp(ip, user) {
  if (!user) return false;
  return isLocalIp(ip) || normalizeIp(ip) === user.ip;
}

module.exports = { normalizeIp, isLocalIp, requireOwnership, verifyAuthIp };
