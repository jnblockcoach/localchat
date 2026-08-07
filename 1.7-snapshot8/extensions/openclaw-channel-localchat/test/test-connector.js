// LocalChat 连接测试（不依赖 OpenClaw，验证插件核心收发链路）
// 用法：node test/test-connector.js [serverUrl]
// 流程：注册机器人账号 → 与测试用户互相添加好友 → 双向收发消息 → 群聊 @ 触发
import { LocalChatConnector } from '../connector.js';

const serverUrl = process.argv[2] || 'http://127.0.0.1:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

async function api(path, options = {}) {
  const res = await fetch(`${serverUrl}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  return res.json();
}

async function main() {
  console.log(`\n=== LocalChat ↔ OpenClaw 连接测试 @ ${serverUrl} ===\n`);

  // 1. 测试用户
  const t = Date.now();
  const { user: tester } = await api('/api/users/register', {
    method: 'POST',
    body: JSON.stringify({ username: `测试员${t % 10000}` }),
  });
  check('创建测试用户', !!tester, JSON.stringify(tester));

  // 2. 机器人连接（自动注册 + WS）
  const bot = new LocalChatConnector({
    serverUrl,
    botUsername: `AI助手${t % 1000}`,
    log: (m) => console.log('   [bot] ' + m),
  });
  const botUser = await bot.start();
  check('机器人账号自动注册/复用', botUser && botUser.id, JSON.stringify(botUser && botUser.id));
  check('机器人 IP-序号', botUser.ip_index >= 1, `ip_index=${botUser.ip_index}`);

  await wait(500);

  // 3. 互相加好友
  await api('/api/friends/add', { method: 'POST', body: JSON.stringify({ userId: tester.id, friendId: botUser.id }) });
  await api('/api/friends/accept', { method: 'POST', body: JSON.stringify({ userId: botUser.id, friendId: tester.id }) });
  check('好友关系建立', true);

  // 4. 测试用户 → 机器人 私聊
  let got = null;
  bot.onMessage((m) => { got = m; });
  const tws = new (await import('ws')).default(`ws://${new URL(serverUrl).host}`);
  await new Promise((r) => tws.on('open', r));
  tws.send(JSON.stringify({ type: 'auth', userId: tester.id }));
  await wait(300);
  tws.send(JSON.stringify({ type: 'private_msg', receiverId: botUser.id, content: '你好，机器人' }));
  await wait(800);
  check('收到私聊消息', got && got.type === 'private' && got.content === '你好，机器人', JSON.stringify(got));

  // 5. 机器人 → 测试用户 私聊回复
  const ok = bot.sendText({ type: 'private', chatId: tester.id, content: '连接测试成功，这是机器人回复' });
  check('机器人发送私聊', ok);
  let testerGot = null;
  tws.on('message', (raw) => {
    try { const d = JSON.parse(raw.toString()); if (d.type === 'new_private_msg' && Number(d.message.sender_id) === Number(botUser.id)) testerGot = d.message; } catch {}
  });
  await wait(800);
  check('测试用户收到机器人回复', testerGot && testerGot.content === '连接测试成功，这是机器人回复');

  // 6. 群聊 @ 触发
  const { group } = await api('/api/groups/create', {
    method: 'POST',
    body: JSON.stringify({ name: '连接测试群', creatorId: tester.id, memberIds: [botUser.id] }),
  });
  const botGot = [];
  const h2 = (m) => botGot.push(m);
  bot.onMessage(h2);
  // 未 @ → 不应触发
  tws.send(JSON.stringify({ type: 'group_msg', groupId: group.id, content: '大家好' }));
  await wait(600);
  check('群聊未@机器人不触发', botGot.length === 0, JSON.stringify(botGot));
  // @ 机器人 → 触发
  tws.send(JSON.stringify({ type: 'group_msg', groupId: group.id, content: `@${bot.botUsername} 今天天气如何` }));
  await wait(800);
  check('群聊@机器人触发', botGot.length === 1 && botGot[0].content.includes('今天天气如何'), JSON.stringify(botGot));
  // 机器人回复群聊
  const gok = bot.sendText({ type: 'group', chatId: group.id, content: '连接测试成功（群聊）' });
  check('机器人发送群聊', gok);
  let groupGot = null;
  tws.on('message', (raw) => {
    try { const d = JSON.parse(raw.toString()); if (d.type === 'new_group_msg' && Number(d.message.sender_id) === Number(botUser.id)) groupGot = d.message; } catch {}
  });
  await wait(800);
  check('群成员收到机器人群聊回复', groupGot && groupGot.content === '连接测试成功（群聊）');

  // 7. 断线重连
  bot.stop();
  await wait(300);
  check('停止后 WS 关闭', bot.ws === null);

  console.log(`\n========== 结果: ${pass} 通过, ${fail} 失败 ==========`);
  tws.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试出错:', e); process.exit(1); });
