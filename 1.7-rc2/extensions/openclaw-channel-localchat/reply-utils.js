// R2：AI 回复切分工具（独立无依赖，便于单元测试）
// 服务端 WS 消息上限 4000 字，超长 AI 回复需要分段发送，避免整条被拒绝后内容丢失。
export const REPLY_MAX = 4000;

// F4/G1：单次回复最多分段数（约 40 万字符），防止极端输出长时间刷屏
// G1：服务端 WS 限流是「固定窗口 30 条/10 秒」，因此每 25 段必须停顿 >10 秒
// （停顿 4 秒会在同一窗口内累积 50 条，后 20 条被拒）
export const REPLY_CHUNK_LIMIT = 100;
export const CHUNK_PAUSE_EVERY = 25;
export const CHUNK_PAUSE_MS = 10500;

export function chunkDelayMs(index) {
  return index > 0 && index % CHUNK_PAUSE_EVERY === 0 ? CHUNK_PAUSE_MS : 0;
}

// G2：截断提示必须塞进单条上限内，否则末段（如恰好 4000 字）会被服务端拒绝
export const TRUNC_NOTICE = '\n…（回复过长，已截断）';

export function fitNotice(text, notice = TRUNC_NOTICE, max = REPLY_MAX) {
  const value = String(text ?? '');
  if (value.length + notice.length <= max) return value + notice;
  return value.slice(0, Math.max(0, max - notice.length)) + notice;
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
