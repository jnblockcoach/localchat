// F11：严格正整数 ID 解析（拒绝 "1abc"、"-1"、"1.5"、超长数字等）
function parseId(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

module.exports = { parseId };
