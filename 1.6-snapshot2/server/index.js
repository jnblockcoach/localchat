const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { initDatabase } = require('./db');
const { setupWebSocket } = require('./websocket');
const logger = require('./logger');

const userRoutes = require('./routes/user');
const friendRoutes = require('./routes/friend');
const groupRoutes = require('./routes/group');
const messageRoutes = require('./routes/message');
const blockRoutes = require('./routes/block');
const fileRoutes = require('./routes/file');
const cliRoutes = require('./routes/cli');

const PORT = 3000;

logger.info('正在初始化数据库...');
initDatabase();
logger.info('数据库初始化完成');

const app = express();
app.use(express.json());
app.use(logger.request);
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/users', userRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/block', blockRoutes);
app.use('/api/files', fileRoutes);
app.use('/cli', cliRoutes);

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
