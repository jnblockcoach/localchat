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

// F7：日志大小轮转（默认 5MB；测试可用 LOCALCHAT_LOG_MAX_BYTES 覆盖）
const MAX_LOG_BYTES = (() => {
  const bytes = parseInt(process.env.LOCALCHAT_LOG_MAX_BYTES, 10);
  if (Number.isFinite(bytes) && bytes > 0) return bytes;
  const mb = parseInt(process.env.LOCALCHAT_LOG_MAX_MB, 10);
  return (Number.isFinite(mb) && mb > 0 ? mb : 5) * 1024 * 1024;
})();

// F7：可用 LOCALCHAT_LOG_REQUESTS=0 关闭逐请求日志（默认开启）
const LOG_REQUESTS = process.env.LOCALCHAT_LOG_REQUESTS !== '0';

const logBase = path.join(LOG_DIR, `server-${new Date().toISOString().slice(0, 10)}`);
const currentLogFile = `${logBase}.log`;

// 同步写：日志量小且需避免异步流的轮转竞态；写入失败仅降级到 console（R10）
let written = 0;
try {
  written = fs.statSync(currentLogFile).size;
} catch {
  written = 0;
}
let rotateSeq = 0;

function writeLine(line) {
  try {
    const bytes = Buffer.byteLength(line, 'utf8') + 1;
    if (written + bytes > MAX_LOG_BYTES) {
      const rotated = `${logBase}-${++rotateSeq}-${Date.now()}.log`;
      try {
        fs.renameSync(currentLogFile, rotated);
      } catch {}
      written = 0;
    }
    fs.appendFileSync(currentLogFile, line + '\n');
    written += bytes;
  } catch (err) {
    console.error(`[logger] 写日志失败: ${err.message}`);
  }
}

function timestamp() {
  const d = new Date();
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

const logger = {
  info(msg, ...args) {
    const line = `[${timestamp()}] [INFO] ${msg}${args.length ? ' ' + args.join(' ') : ''}`;
    console.log(line);
    writeLine(line);
  },

  warn(msg, ...args) {
    const line = `[${timestamp()}] [WARN] ${msg}${args.length ? ' ' + args.join(' ') : ''}`;
    console.warn(line);
    writeLine(line);
  },

  error(msg, ...args) {
    const line = `[${timestamp()}] [ERROR] ${msg}${args.length ? ' ' + args.join(' ') : ''}`;
    console.error(line);
    writeLine(line);
  },

  request(req, res, next) {
    if (!LOG_REQUESTS) return next();
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
    });
    next();
  },
};

module.exports = logger;
