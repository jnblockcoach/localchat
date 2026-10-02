// IP 身份验证：通过请求来源 IP 识别/验证身份
// 规则：账号只能由「注册 IP 相同」或「服务器本机」发起操作（服务器本机 IP 与 127.0.0.1 均视为本机）
// 安全原则（1.7-preview5 Z1-Z3）：默认拒绝（fail-closed）。
//   - 远端请求必须提供合法、存在且与来源 IP 匹配的账号 ID，缺省/非法一律拒绝；
//   - 仅服务器本机允许「无身份」访问（插件/运维信任本机），远端不再放行；
//   - 校验通过后把身份写入 req.authUserId，业务层应以此为准，避免「中间件验 A、业务用 B」。
const os = require('os');
const UserModel = require('../models/user');
const logger = require('../logger');

// 规范化客户端 IP：IPv6 映射地址 ::ffff:x.x.x.x 还原为 IPv4
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
      // L7：IPv4 与 IPv6 非内网地址均视为本机
      if (!net.internal && net.address === normalized) return true;
    }
  }
  return false;
}

// 验证请求来源 IP 与账号归属一致（getUserId 从请求中提取账号 ID）
// 通过后在 req.authUserId 写入已验证身份
function requireOwnership(getUserId) {
  return (req, res, next) => {
    try {
      const ip = normalizeIp(req.ip);
      const raw = getUserId(req);

      // 1) 未声明身份：仅服务器本机放行（插件/运维），远端一律拒绝
      if (raw === undefined || raw === null || raw === '') {
        if (isLocalIp(ip)) {
          req.authUserId = null;
          return next();
        }
        logger.warn(`身份验证拒绝（缺少用户ID）: ip=${ip} ${req.method} ${req.originalUrl}`);
        return res.status(401).json({ error: '缺少用户ID' });
      }

      // 2) 身份必须是合法存在的账号
      const userId = Number(raw);
      if (!Number.isInteger(userId) || userId <= 0) {
        logger.warn(`身份验证拒绝（用户ID非法）: ip=${ip} userId=${raw}`);
        return res.status(401).json({ error: '用户ID非法' });
      }
      const user = UserModel.findById(userId);
      if (!user) {
        logger.warn(`身份验证拒绝（用户不存在）: ip=${ip} userId=${userId}`);
        return res.status(401).json({ error: '用户不存在' });
      }

      // 3) 来源 IP 必须归该账号（或本机）
      if (isLocalIp(ip) || ip === normalizeIp(user.ip)) {
        req.authUserId = userId;
        return next();
      }

      logger.warn(`身份验证拒绝（IP 不符）: ip=${ip} userId=${userId} userIp=${normalizeIp(user.ip)} ${req.method} ${req.originalUrl}`);
      return res.status(403).json({ error: '身份验证失败：该账号不属于当前设备 IP' });
    } catch (err) {
      // fail-closed：异常按拒绝处理
      logger.error(`身份验证异常: ${err.message}`);
      return res.status(403).json({ error: '身份验证失败' });
    }
  };
}

// 校验 WS 认证来源 IP
function verifyAuthIp(ip, user) {
  if (!user) return false;
  return isLocalIp(ip) || normalizeIp(ip) === normalizeIp(user.ip);
}

module.exports = { normalizeIp, isLocalIp, requireOwnership, verifyAuthIp };
