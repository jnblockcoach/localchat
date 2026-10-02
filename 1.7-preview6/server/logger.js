const fs = require('fs');
const path = require('path');

// 支持环境变量覆盖日志目录（自动化测试用），默认项目 logs/
const LOG_DIR = process.env.LOCALCHAT_DATA_DIR
  ? path.join(process.env.LOCALCHAT_DATA_DIR, 'logs')
  : path.join(__dirname, '..', 'logs');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Remove log files older than 7 days
try {
  const files = fs.readdirSync(LOG_DIR);
  const now = Date.now();
  for (const f of files) {
    const fp = path.join(LOG_DIR, f);
    const stat = fs.statSync(fp);
    if (stat.isFile() && now - stat.mtimeMs > 7 * 86400000) {
      fs.unlinkSync(fp);
    }
  }
} catch {}

const logFile = path.join(LOG_DIR, `server-${new Date().toISOString().slice(0, 10)}.log`);
const stream = fs.createWriteStream(logFile, { flags: 'a' });

function timestamp() {
  const d = new Date();
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

const logger = {
  info(msg, ...args) {
    const line = `[${timestamp()}] [INFO] ${msg}${args.length ? ' ' + args.join(' ') : ''}`;
    console.log(line);
    stream.write(line + '\n');
  },

  warn(msg, ...args) {
    const line = `[${timestamp()}] [WARN] ${msg}${args.length ? ' ' + args.join(' ') : ''}`;
    console.warn(line);
    stream.write(line + '\n');
  },

  error(msg, ...args) {
    const line = `[${timestamp()}] [ERROR] ${msg}${args.length ? ' ' + args.join(' ') : ''}`;
    console.error(line);
    stream.write(line + '\n');
  },

  request(req, res, next) {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
    });
    next();
  },
};

module.exports = logger;
