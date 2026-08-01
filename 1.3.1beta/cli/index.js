#!/usr/bin/env node

// Parse command line arguments
const args = process.argv.slice(2);
const help = args.includes('--help') || args.includes('-h');

if (help) {
  console.log(`
  LocalChat - 局域网即时通讯
  ============================

  用法:
    localchat                     连接 localhost:3000
    localchat --server <host>     指定服务器地址
    localchat --port <port>       指定端口
    localchat --server <host:port>  同时指定地址和端口
    localchat --help              显示帮助

  示例:
    localchat
    localchat --server 192.168.1.100
    localchat --server 192.168.1.100 --port 8080
    localchat --server 192.168.1.100:8080
  `);
  process.exit(0);
}

const config = require('./config');
const Client = require('./client');
const TerminalUI = require('./term');

function parseArgs() {
  let server = '127.0.0.1';
  let port = 3000;

  const saved = config.load();
  if (saved.server) server = saved.server;
  if (saved.port) port = saved.port;

  const serverIdx = args.indexOf('--server');
  if (serverIdx !== -1 && serverIdx + 1 < args.length) {
    const val = args[serverIdx + 1];
    if (val.includes(':')) {
      const parts = val.split(':');
      server = parts[0];
      port = parseInt(parts[1]) || port;
    } else {
      server = val;
    }
  }

  const portIdx = args.indexOf('--port');
  if (portIdx !== -1 && portIdx + 1 < args.length) {
    port = parseInt(args[portIdx + 1]) || port;
  }

  config.save({ server, port });
  return { server, port };
}

async function main() {
  const { server, port } = parseArgs();

  const client = new Client(server, port);
  const ui = new TerminalUI(client);
  await ui.run();
}

main().catch((err) => {
  console.error('启动失败:', err.message);
  process.exit(1);
});
