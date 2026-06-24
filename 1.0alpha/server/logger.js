const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

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
