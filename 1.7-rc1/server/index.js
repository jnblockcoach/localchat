const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { initDatabase } = require('./db');
const { setupWebSocket } = require('./websocket');
const { cleanupOrphanFiles } = require('./cleanup');
const { rateLimit } = require('./middleware/rateLimit');
const logger = require('./logger');

const userRoutes = require('./routes/user');
const friendRoutes = require('./routes/friend');
const groupRoutes = require('./routes/group');
const messageRoutes = require('./routes/message');
const blockRoutes = require('./routes/block');
const fileRoutes = require('./routes/file');
const cliRoutes = require('./routes/cli');
const aiRoutes = require('./routes/ai');

const PORT = parseInt(process.env.PORT, 10) || 3000;

logger.info('正在初始化数据库...');
initDatabase();
logger.info('数据库初始化完成');

// R19：启动时清理孤儿文件（之后每 24 小时一次，unref 不阻止退出）
try {
  cleanupOrphanFiles();
} catch (err) {
  logger.warn(`孤儿文件清理失败: ${err.message}`);
}
setInterval(() => {
  try {
    cleanupOrphanFiles();
  } catch (err) {
    logger.warn(`孤儿文件清理失败: ${err.message}`);
  }
}, 86400000).unref();

const app = express();
// 关闭 ETag：避免浏览器条件请求得到 304 空响应导致前端 res.json() 失败
app.set('etag', false);
// R21：基础安全响应头（无外部资源依赖，允许内联样式/脚本以兼容现有前端）
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'"
  );
  next();
});
// R16：全局 API 限流（每分钟每 IP 300 次），单路由另有更严格限制
app.use('/api', rateLimit({ windowMs: 60000, max: 300 }));
app.use(express.json());
app.use(logger.request);
// API 响应禁用缓存（双保险）
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/users', userRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/block', blockRoutes);
app.use('/api/files', fileRoutes);
app.use('/cli', cliRoutes);
app.use('/api/ai', aiRoutes);

const server = http.createServer(app);

const wss = new WebSocketServer({ server });
setupWebSocket(wss);

server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push(net.address);
      }
    }
  }

  logger.info('========================================');
  logger.info('  LocalChat 已启动');
  logger.info('========================================');
  logger.info(`  本机访问: http://127.0.0.1:${PORT}`);
  addresses.forEach((addr) => {
    logger.info(`  局域网访问: http://${addr}:${PORT}`);
  });
  logger.info('========================================');
});
