#!/usr/bin/env node

const readline = require('readline');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Client = require('./client');

// ===== 参数解析 =====

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  LocalChat 命令行便携版
  ======================
  仅保留好友对话与添加好友，是完整命令行版的简单版本。

  用法:
    localchat-portable                     连接 localhost:3000
    localchat-portable --server <host>     指定服务器地址
    localchat-portable --port <port>       指定端口
    localchat-portable --server <host:port>  同时指定地址和端口
    localchat-portable --help              显示帮助

  示例:
    localchat-portable
    localchat-portable --server 192.168.1.100
    localchat-portable --server 192.168.1.100:3000
  `);
  process.exit(0);
}

const CONFIG_PATH = path.join(os.homedir(), '.localchat-portable', 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch {}
  return { server: '127.0.0.1', port: 3000 };
}

function saveConfig(data) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...loadConfig(), ...data }, null, 2));
  } catch {}
}

function parseArgs() {
  const saved = loadConfig();
  let server = saved.server || '127.0.0.1';
  let port = saved.port || 3000;

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

  // 不再在此处保存：连接成功后才记住地址（见 run()）
  return { server, port };
}

// ===== 主程序 =====

class PortableChat {
  constructor(server, port) {
    this.server = server;
    this.port = port;
    this.client = new Client(server, port);
    this.user = null;
    this.friends = [];
    this.onlineUsers = new Set();
    this.currentFriendId = null;

    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.rl.on('line', (line) => this._onLine(line));
    this.rl.on('SIGINT', () => this._quit());

    this._setupWsHandlers();
  }

  ask(question) {
    return new Promise((resolve) => this.rl.question(question, resolve));
  }

  // 打印一行（清掉当前输入行避免与输出交错），登录后自动刷新提示符
  _print(line) {
    process.stdout.write('\r\x1b[2K');
    console.log(line);
    if (this.user) this._prompt();
  }

  _printLines(lines) {
    process.stdout.write('\r\x1b[2K');
    console.log(lines.join('\n'));
    if (this.user) this._prompt();
  }

  _prompt() {
    const who = this.currentFriendId
      ? `#${this.currentFriendId}> `
      : this.user
        ? `${this.user.username}#${this.user.id}> `
        : '> ';
    this.rl.setPrompt(who);
    this.rl.prompt();
  }

  async run() {
    this._printLines([
      '========================================',
      '  LocalChat 命令行便携版',
      '  仅好友对话与添加好友',
      '========================================',
      `服务器: ${this.client.baseUrl}`,
      '',
    ]);

    // 启动前先检测服务器是否可用
    const check = await this.client.getUsersByIp();
    if (!Array.isArray(check)) {
      console.log('');
      console.log(`✗ 无法连接服务器 ${this.client.baseUrl}`);
      console.log('  请先启动 LocalChat 服务器，再运行本程序：');
      console.log('  1. 在项目目录 (1.4beta) 执行:  npm install');
      console.log('  2. 启动服务器:  npm start');
      console.log('  3. 重新运行:  npm run portable');
      console.log('  如果是连接其他电脑的服务器，请用:  npm run portable -- --server <IP>:<端口>');
      process.exit(1);
    }

    // 连接成功才记住服务器地址，避免错误配置残留
    saveConfig({ server: this.server, port: this.port });

    this.client.connect();
    await this._loginFlow();
    this._printHelp();
    this._prompt();
  }

  // ===== 登录 =====

  async _loginFlow() {
    for (;;) {
      const lines = ['1. 创建新账号', '2. 用ID登录'];
      let ipUsers = [];
      try {
        const res = await this.client.getUsersByIp();
        ipUsers = Array.isArray(res) ? res : [];
      } catch {}
      if (ipUsers.length > 0) {
        lines.push('3. 本机已有账号:');
        ipUsers.forEach((u) => lines.push(`     #${u.id} ${u.username}`));
      }
      lines.push('0. 退出');
      this._printLines(lines);

      const choice = (await this.ask('请选择: ')).trim();

      if (choice === '0' || choice.toLowerCase() === 'q') {
        this._quit();
        return;
      }

      if (choice === '1') {
        const name = (await this.ask('输入昵称: ')).trim();
        if (!name) { this._print('昵称不能为空'); continue; }
        const res = await this.client.register(name);
        if (res.error) { this._print('注册失败: ' + res.error); continue; }
        this._print(`注册成功！你的账号ID是: ${res.user.id}，请牢记此ID用于登录`);
        this._enterApp(res.user);
        return;
      }

      if (choice === '2') {
        const id = parseInt((await this.ask('输入ID: ')).trim());
        if (!id) { this._print('无效ID'); continue; }
        const res = await this.client.login(id);
        if (res.error) { this._print('登录失败: ' + res.error); continue; }
        this._enterApp(res.user);
        return;
      }

      if (choice === '3' && ipUsers.length > 0) {
        const idx = parseInt((await this.ask('选择账号编号: ')).trim());
        if (!idx || idx < 1 || idx > ipUsers.length) { this._print('无效选择'); continue; }
        const res = await this.client.login(ipUsers[idx - 1].id);
        if (res.error) { this._print('登录失败: ' + res.error); continue; }
        this._enterApp(res.user);
        return;
      }

      this._print('无效选择');
    }
  }

  _enterApp(user) {
    this.user = user;
    this.client.user = user;
    this.client.wsAuth();
    this._print(`已登录: ${user.username} (#${user.id})`);
  }

  // ===== 命令 =====

  _printHelp() {
    this._printLines([
      '── 可用命令 ──────────────────────────────',
      '  /list          好友列表 (含在线状态)',
      '  /add <ID>      添加好友',
      '  /requests      查看好友请求',
      '  /accept <ID>   接受好友请求',
      '  /msg <ID>      打开与好友的对话',
      '  /back          退出当前对话',
      '  /quit          退出程序',
      '──────────────────────────────────────────',
      '进入对话后直接输入内容即可发送消息',
    ]);
  }

  async _showFriends() {
    let friends = [];
    try {
      const res = await this.client.getFriends(this.user.id);
      friends = Array.isArray(res) ? res : [];
    } catch {}
    this.friends = friends;
    if (friends.length === 0) {
      this._print('暂无好友，输入 /add <用户ID> 添加好友');
      return;
    }
    const lines = [`--- 好友列表 (${friends.length}) ---`];
    for (const f of friends) {
      const online = this.onlineUsers.has(Number(f.id)) ? '●在线' : '○离线';
      lines.push(`  #${f.id} ${f.username} (${f.ip}) ${online}    输入 /msg ${f.id} 聊天`);
    }
    this._printLines(lines);
  }

  async _addFriend(friendId) {
    if (Number(friendId) === Number(this.user.id)) {
      this._print('不能添加自己为好友');
      return;
    }
    const res = await this.client.addFriend(this.user.id, friendId);
    if (res.error) this._print('添加失败: ' + res.error);
    else this._print('好友请求已发送给 #' + friendId);
  }

  async _showRequests() {
    let requests = [];
    try {
      const res = await this.client.getPendingRequests(this.user.id);
      requests = Array.isArray(res) ? res : [];
    } catch {}
    if (requests.length === 0) {
      this._print('暂无好友请求');
      return;
    }
    const lines = [`--- 好友请求 (${requests.length}) ---`];
    for (const r of requests) {
      lines.push(`  #${r.id} ${r.username} (${r.ip})    输入 /accept ${r.id} 接受`);
    }
    this._printLines(lines);
  }

  async _acceptFriend(friendId) {
    const res = await this.client.acceptFriend(this.user.id, friendId);
    if (res.error) { this._print('操作失败: ' + res.error); return; }
    this._print('已接受 #' + friendId + ' 的好友请求');
    try { this.friends = await this.client.getFriends(this.user.id); } catch {}
  }

  async _openChat(friendId) {
    this.currentFriendId = friendId;
    this._print(`--- 与 #${friendId} 的对话 (直接输入内容发送, /back 返回) ---`);
    try {
      const res = await this.client.getPrivateHistory(this.user.id, friendId, 50, this.user.id);
      const msgs = Array.isArray(res) ? res : [];
      if (msgs.length === 0) {
        this._print('(暂无历史消息)');
        return;
      }
      for (const m of msgs) {
        const who = Number(m.sender_id) === Number(this.user.id) ? '你' : (m.sender_name || '#' + m.sender_id);
        const time = m.created_at ? m.created_at.slice(11, 16) : '';
        this._print(`[${time}] ${who}: ${m.content}`);
      }
    } catch {
      this._print('历史消息加载失败');
    }
  }

  async _handleCommand(cmd) {
    const parts = cmd.slice(1).split(/\s+/);
    const name = parts[0].toLowerCase();

    switch (name) {
      case 'help':
        this._printHelp();
        break;
      case 'list':
        await this._showFriends();
        break;
      case 'add':
        if (!parts[1] || !parseInt(parts[1])) { this._print('用法: /add <用户ID>'); break; }
        await this._addFriend(parseInt(parts[1]));
        break;
      case 'requests':
        await this._showRequests();
        break;
      case 'accept':
        if (!parts[1] || !parseInt(parts[1])) { this._print('用法: /accept <用户ID>'); break; }
        await this._acceptFriend(parseInt(parts[1]));
        break;
      case 'msg':
        if (!parts[1] || !parseInt(parts[1])) { this._print('用法: /msg <好友ID>'); break; }
        await this._openChat(parseInt(parts[1]));
        break;
      case 'back':
        this.currentFriendId = null;
        this._print('已退出对话');
        break;
      case 'quit':
      case 'exit':
        this._quit();
        break;
      default:
        this._print('未知命令: ' + cmd + ' (输入 /help 查看帮助)');
    }
  }

  // ===== 输入处理 =====

  _onLine(line) {
    const text = line.trim();
    if (!text) { this._prompt(); return; }

    if (text.startsWith('/')) {
      this._handleCommand(text).catch((err) => {
        this._print('命令执行失败: ' + (err.message || err));
      });
      return;
    }

    if (this.currentFriendId) {
      const ok = this.client.sendPrivateMsg(this.currentFriendId, text);
      if (!ok) {
        this._print('发送失败：连接已断开，正在自动重连...');
      } else {
        // 发送成功后由服务器回显显示消息（避免重复打印）
        this._prompt();
      }
    } else {
      this._print('未选择对话。输入 /msg <好友ID> 开始聊天，或 /help 查看帮助');
    }
  }

  // ===== WebSocket 事件 =====

  _setupWsHandlers() {
    this.client.on('ws_open', () => {
      if (!this.user) return;
      this._print('● 连接已建立');
    });

    this.client.on('ws_close', () => {
      if (!this.user) return;
      this._print('○ 连接断开，3秒后自动重连...');
    });

    this.client.on('new_private_msg', (data) => {
      if (!this.user) return;
      const msg = data.message;
      const time = msg.created_at ? msg.created_at.slice(11, 16) : '';
      const fromMe = Number(msg.sender_id) === Number(this.user.id);
      const who = fromMe ? '你' : (msg.sender_name || '#' + msg.sender_id);

      if (fromMe && Number(msg.receiver_id) === Number(this.currentFriendId)) {
        this._print(`[${time}] ${who}: ${msg.content}`);
      } else if (!fromMe && Number(msg.sender_id) === Number(this.currentFriendId)) {
        this._print(`[${time}] ${who}: ${msg.content}`);
      } else if (!fromMe) {
        this._print(`[新私聊] ${who}: ${msg.content}    输入 /msg ${msg.sender_id} 回复`);
      }
    });

    this.client.on('friend_online', (data) => {
      if (!this.user) return;
      this.onlineUsers.add(Number(data.userId));
      if (Number(data.userId) === Number(this.user.id)) return;
      this._print(`[在线] #${data.userId} 上线了`);
    });

    this.client.on('friend_offline', (data) => {
      if (!this.user) return;
      this.onlineUsers.delete(Number(data.userId));
      this._print(`[离线] #${data.userId} 下线了`);
    });

    this.client.on('online_users', (data) => {
      if (!this.user) return;
      this.onlineUsers = new Set(data.userIds.map(Number));
    });

    this.client.on('friend_request', (data) => {
      if (!this.user) return;
      const from = data.from || {};
      this._print(`[好友请求] ${from.username || ''} (#${from.id}) 请求添加你为好友，输入 /requests 查看`);
    });

    this.client.on('request_handled', (data) => {
      if (!this.user) return;
      if (data && data.status === 'accepted') {
        this._print('[通知] 你的好友请求已被接受');
      }
    });

    this.client.on('new_friend', (data) => {
      if (!this.user) return;
      const u = data.user || {};
      this._print(`[新好友] ${u.username || ''} (#${u.id}) 已成为你的好友，输入 /msg ${u.id} 聊天`);
    });

    // 服务器返回的业务错误（拉黑拒绝、非群成员等）
    this.client.on('error', (data) => {
      if (!this.user) return;
      this._print('⚠ ' + ((data && data.message) || '服务器返回错误'));
    });
  }

  _quit() {
    try { this.client.disconnect(); } catch {}
    console.log('再见！');
    process.exit(0);
  }
}

// ===== 启动 =====

const { server, port } = parseArgs();
const app = new PortableChat(server, port);
app.run().catch((err) => {
  console.error('启动失败:', err.message);
  process.exit(1);
});
