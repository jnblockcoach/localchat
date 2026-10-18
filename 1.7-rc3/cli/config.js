const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.localchat');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function load() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch {}
  return { server: '127.0.0.1', port: 3000 };
}

function save(data) {
  ensureDir();
  try {
    const existing = load();
    const merged = { ...existing, ...data };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.error('保存配置失败:', err.message);
  }
}

module.exports = { load, save };
