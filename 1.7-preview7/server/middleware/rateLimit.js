// R16：轻量固定窗口限流（单进程内存；局域网小规模足够）
const { normalizeIp } = require('./auth');

const hits = new Map();

function rateLimit({ windowMs = 60000, max = 60, message = '请求过于频繁，请稍后再试' } = {}) {
  // 限流器作用域参与 key：避免与全局/其他限流器共用同一个计数桶（否则请求会被重复计数）
  const scope = `${max}:${windowMs}`;
  return (req, res, next) => {
    const key = `${scope}:${normalizeIp(req.ip)}:${req.method}:${req.baseUrl || ''}${req.path}`;
    const now = Date.now();
    let bucket = hits.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      hits.set(key, bucket);
    }
    bucket.count++;

    // 机会式清理，避免 Map 无限增长
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (v.resetAt <= now) hits.delete(k);
      }
    }

    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

module.exports = { rateLimit };
