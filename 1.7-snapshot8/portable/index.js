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
        ipUsers.forEach((u) => {
          const idLabel = u.is_ai ? (u.display_id || ('openclaw-' + u.ip + '-?')) : (u.ip + '-' + (u.ip_index || '?'));
          lines.push(`     #${u.id} ${u.username} (${idLabel})`);
        });
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
        this._print(`注册成功！你的账号是 ${res.user.ip}-${res.user.ip_index || '?'} (#${res.user.id})，请牢记此ID用于登录`);
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
    const lines = [];
    if (requests.length > 0) {
      lines.push(`--- 好友请求 (${requests.length}) ---`);
      for (const r of requests) {
        lines.push(`  #${r.id} ${r.username} (${r.ip})    输入 /accept ${r.id} 接受`);
      }
    }
    // 显示 OpenClaw 互联请求（M5：三端同等级展示）
    try {
      const pres = await this.client.getAiPeers();
      const peers = (pres && pres.peers) || [];
      const pending = peers.filter((p) => p.status === 'pending');
      if (pending.length > 0) {
        lines.push(`--- OpenClaw 互联请求 (${pending.length}) ---`);
        for (const p of pending) {
          lines.push(`  📡 机器 ${p.ip} 请求互联 OpenClaw    输入 /interconnect-accept ${p.ip} 同意（无法拒绝）`);
        }
      }
    } catch {}
    if (lines.length === 0) {
      this._print('暂无好友请求/互联请求');
      return;
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
        const time = this._fmtTime(m.created_at);
        this._print(`[${time}] ${who}: ${m.content}`);
      }
    } catch {
      this._print('历史消息加载失败');
    }
  }

  // AI 助理注册：检测本机 OpenClaw → 输入名称 → 注册并自动加为好友
  async _aiSetup() {
    let status = null;
    try {
      status = await this.client.getAiStatus(this.user ? this.user.id : null);
    } catch {
      this._print('无法连接服务器');
      return;
    }
    const oc = (status && status.openclaw) || {};
    if (!oc.running) {
      this._print('未检测到本机运行的 OpenClaw（请先启动 OpenClaw gateway）');
      return;
    }
    if (status.account) {
      this._print(`AI 助理已注册：${status.account.username}（${status.account.display_id || ('openclaw-' + status.account.ip + '-?')}）`);
      return;
    }
    const name = (await this.ask('检测到本机 OpenClaw，输入 AI 助理名称: ')).trim();
    if (!name) { this._print('名称不能为空'); return; }
    const res = await this.client.registerAi(name, this.user ? this.user.id : null);
    if (res.error) { this._print('注册失败: ' + res.error); return; }
    this._print(`✓ AI 助理已注册：${res.user.username}（${res.user.display_id || ('openclaw-' + res.user.ip + '-?')}），已自动加为好友`);
  }

  // 查看 AI Workspace：/workspace [文件名]
  async _aiWorkspace(file) {
    try {
      const res = await this.client.getAiWorkspace(file, this.user ? this.user.id : null);
      if (res.error) { this._print('读取失败: ' + res.error); return; }
      if (!file) {
        if (res.files.length === 0) { this._print('Workspace 为空'); return; }
        const lines = ['--- AI Workspace 文件 ---'];
        for (const f of res.files) lines.push(`  ${f.name} (${(f.size / 1024).toFixed(1)}KB)`);
        lines.push('查看内容: /workspace <文件名>');
        this._printLines(lines);
        return;
      }
      this._print(`--- ${res.name} ---`);
      this._print(res.content);
    } catch {
      this._print('读取失败');
    }
  }

  // 机器互联 OpenClaw：/interconnect <目标IP>；无参数时显示当前互联状态
  async _aiInterconnect(ip) {
    if (!ip) {
      try {
        const r = await this.client.getAiPeers();
        const peers = (r && r.peers) || [];
        if (peers.length === 0) { this._print('暂无互联（/interconnect <目标IP> 发起请求）'); return; }
        const lines = ['--- OpenClaw 互联 ---'];
        for (const p of peers) lines.push(`  ${p.ip} ${p.status === 'accepted' ? '● 已互联' : '○ 等待对方确认'}`);
        this._printLines(lines);
        return;
      } catch { this._print('查询失败'); return; }
    }
    const res = await this.client.interconnectOpenClaw(ip);
    this._print(res.error ? '发起失败: ' + res.error : (res.message || '请求已发送'));
  }

  // 同意 OpenClaw 互联（对方无法拒绝，只能同意或忽略）
  async _aiInterconnectAccept(ip) {
    const res = await this.client.acceptAiPeer(ip, this.user ? this.user.id : null);
    this._print(res.error ? '操作失败: ' + res.error : (res.message || '已同意互联'));
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
      case 'ai':
        await this._aiSetup();
        break;
      case 'workspace':
        await this._aiWorkspace(parts.slice(1).join(' ') || null);
        break;
      case 'interconnect':
        await this._aiInterconnect(parts.slice(1).join(' ') || null);
        break;
      case 'interconnect-accept':
        if (!parts[1]) { this._print('用法: /interconnect-accept <目标IP>'); break; }
        await this._aiInterconnectAccept(parts[1]);
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
      // 断线重连成功：补偿断线期间错过的当前对话消息（只打印断线后的新消息）
      if (this.currentFriendId) {
        this._reloadCurrentChat();
      }
    });

    this.client.on('ws_close', () => {
      if (!this.user) return;
      this._disconnectedAt = Date.now();
      this._print('○ 连接断开，3秒后自动重连...');
    });

    this.client.on('new_private_msg', (data) => {
      if (!this.user) return;
      const msg = data.message;
      const time = this._fmtTime(msg.created_at);
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

    // OpenClaw 互联请求实时提示
    this.client.on('openclaw_request', (data) => {
      if (!this.user) return;
      const fromIp = (data && data.fromIp) || '';
      this._print(`📡 ${fromIp} 请求互联 OpenClaw：/requests 查看并同意`);
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

    // 好友关系被对方解除：实时提示
    this.client.on('friend_removed', (data) => {
      if (!this.user) return;
      const by = (data && data.by) || {};
      this._print(`⚠ ${by.username || ('#' + by.id) || '对方'} 删除了好友关系`);
      if (this.currentFriendId && Number(this.currentFriendId) === Number(by.id)) {
        this.currentFriendId = null;
        this._print('已退出当前对话');
      }
      this._prompt();
    });

    // 被其他设备顶替登录：连接已关闭且不再重连
    this.client.on('kicked', () => {
      if (!this.user) return;
      this._print('⚠ 该账号已在其他设备登录，本连接已被关闭（请退出后重新登录）');
    });

    // 服务器返回的业务错误（拉黑拒绝、非群成员等）
    this.client.on('error', (data) => {
      if (!this.user) return;
      this._print('⚠ ' + ((data && data.message) || '服务器返回错误'));
    });
  }

  // 断线期间的消息补偿：只打印断线时间之后的新消息，避免刷屏
  async _reloadCurrentChat() {
    try {
      const res = await this.client.getPrivateHistory(this.user.id, this.currentFriendId, 50, this.user.id);
      const msgs = Array.isArray(res) ? res : [];
      const since = this._disconnectedAt || 0;
      const fresh = msgs.filter((m) => {
        try { return new Date(m.created_at + 'Z').getTime() > since; } catch { return false; }
      });
      for (const m of fresh) {
        const who = Number(m.sender_id) === Number(this.user.id) ? '你' : (m.sender_name || '#' + m.sender_id);
        const time = this._fmtTime(m.created_at);
        this._print(`[${time}] ${who}: ${m.content}`);
      }
    } catch {}
  }

  // 服务器时间字段为 UTC，这里转换为本机本地时间显示（HH:MM）
  _fmtTime(createdAt) {
    if (!createdAt) return '';
    const d = new Date(createdAt + 'Z');
    if (isNaN(d.getTime())) return '';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
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
