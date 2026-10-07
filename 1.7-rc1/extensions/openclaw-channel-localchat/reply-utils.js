// R2：AI 回复切分工具（独立无依赖，便于单元测试）
// 服务端 WS 消息上限 4000 字，超长 AI 回复需要分段发送，避免整条被拒绝后内容丢失。
export const REPLY_MAX = 4000;

// F4：单次回复最多分段数（约 40 万字符），防止极端输出长时间刷屏
// 同时每 25 段插入 4 秒停顿，避开服务端「每连接 10 秒 30 条」的 WS 限流
export const REPLY_CHUNK_LIMIT = 100;
export const CHUNK_PAUSE_EVERY = 25;
export const CHUNK_PAUSE_MS = 4000;

export function chunkDelayMs(index) {
  return index > 0 && index % CHUNK_PAUSE_EVERY === 0 ? CHUNK_PAUSE_MS : 0;
}

// 将超长文本按换行边界切分为多条（每条 <= max），尽量不丢内容
export function splitReply(text, max = REPLY_MAX) {
  const value = String(text ?? '');
  if (!value) return [];
  if (value.length <= max) return [value];

  const chunks = [];
  let rest = value;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < Math.floor(max * 0.5)) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}
