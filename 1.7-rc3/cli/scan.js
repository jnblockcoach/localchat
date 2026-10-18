// 局域网 LocalChat 服务器扫描
// 并行探测本机所在子网的所有 IP（1-254）的指定端口，返回响应 LocalChat API 的服务器列表
const os = require('os');

function getLocalSubnets() {
  const nets = os.networkInterfaces();
  const subnets = new Set();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        const parts = net.address.split('.');
        subnets.add(parts[0] + '.' + parts[1] + '.' + parts[2]);
      }
    }
  }
  return [...subnets];
}

async function probe(ip, port, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${ip}:${port}/api/users/online`, {
      signal: controller.signal,
    });
    if (res.status !== 200) return false;
    const text = await res.text();
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function scanLocalServers({ ports = [3000], timeoutMs = 400, concurrency = 40 } = {}) {
  const subnets = getLocalSubnets();
  const ips = [];
  for (const sub of subnets) {
    for (let i = 1; i < 255; i++) ips.push(`${sub}.${i}`);
  }
  const uniquePorts = [...new Set(ports.map((p) => Number(p)).filter((p) => p > 0))];

  const found = [];
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < ips.length) {
      const ip = ips[idx++];
      for (const port of uniquePorts) {
        if (await probe(ip, port, timeoutMs)) {
          found.push({ ip, port });
        }
      }
    }
  });
  await Promise.all(workers);
  return found;
}

module.exports = { scanLocalServers };
