// R16/F1/G3：轻量固定窗口限流（单进程内存）
// F1：桶数量硬上限 + 摊销清理 + 只淘汰超额数量的最旧桶
// G3：支持 keyBy='ip'（全局限流按 IP 聚合）——避免大量不同路径（含 404）创建海量桶，
//     或把自己的路由桶挤出 LRU 从而绕过限流
const { normalizeIp } = require('./auth');

const hits = new Map();
const MAX_ENTRIES = 20000; // 桶数量硬上限（超出淘汰最旧）
const CLEAN_EVERY = 1000; // 每 N 次请求做一次过期清理
let ops = 0;

// 摊销清理过期桶（每 CLEAN_EVERY 次调用一次）
function cleanupExpired(now) {
  for (const [k, v] of hits) {
    if (v.resetAt <= now) hits.delete(k);
  }
}

// 只淘汰超出上限数量的最旧桶（Map 按插入顺序），复杂度 O(excess)
function evictOldest(excess) {
  if (excess <= 0) return;
  for (const k of hits.keys()) {
    hits.delete(k);
    if (--excess <= 0) break;
  }
}

function rateLimit({ windowMs = 60000, max = 60, message = '请求过于频繁，请稍后再试', keyBy = 'route' } = {}) {
  // 限流器作用域参与 key：避免与全局/其他限流器共用同一个计数桶（否则请求会被重复计数）
  const scope = `${keyBy}:${max}:${windowMs}`;
  return (req, res, next) => {
    const now = Date.now();
    if (++ops % CLEAN_EVERY === 0) cleanupExpired(now);

    const ip = normalizeIp(req.ip);
    const key =
      keyBy === 'ip'
        ? `${scope}:${ip}`
        : `${scope}:${ip}:${req.method}:${req.baseUrl || ''}${req.path}`;
    let bucket = hits.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      hits.set(key, bucket);
      evictOldest(hits.size - MAX_ENTRIES);
    }
    bucket.count++;

    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

// 仅测试使用：查看当前桶数量
function _bucketCount() {
  return hits.size;
}

module.exports = { rateLimit, _bucketCount };
