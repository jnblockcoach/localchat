const MessageModel = require('./models/message');
const FileModel = require('./models/file');
const FriendModel = require('./models/friend');
const GroupModel = require('./models/group');
const UserModel = require('./models/user');
const BlockModel = require('./models/block');
const { verifyAuthIp, normalizeIp } = require('./middleware/auth');
const { stripControl } = require('./sanitize');
const { parseId } = require('./util/parse');
const logger = require('./logger');

const clients = new Map();

// M3：消息长度上限（与前端 maxlength 保持一致，服务端强校验）
const MESSAGE_MAX = 4000;

// M1：判断文本中是否 @ 了某个用户名（支持中文/空格等任意字符）
// ASCII 用户名后要求非单词字符边界，避免 @bob 命中 @bobby
function isMentioned(content, username) {
  if (!username) return false;
  const token = '@' + username;
  let idx = content.indexOf(token);
  while (idx !== -1) {
    const next = content[idx + token.length];
    if (next === undefined || !/[A-Za-z0-9_]/.test(next)) return true;
    idx = content.indexOf(token, idx + 1);
  }
  return false;
}

function setupWebSocket(wss) {
  wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    logger.info(`WS 新连接: ${clientIp}`);
    ws.isAlive = true;

    // 未认证连接 30 秒超时断开（防资源占用）
    ws._authTimer = setTimeout(() => {
      if (!ws.userId) {
        logger.warn(`WS 未认证超时断开: ${clientIp}`);
        try { ws.close(1008, 'auth timeout'); } catch {}
      }
    }, 30000);

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        logger.warn(`WS 无效消息格式: ${raw.toString().slice(0, 100)}`);
        return sendError(ws, '无效的消息格式');
      }

      logger.info(`WS ${clientIp} -> ${data.type}${data.userId ? ` (userId=${data.userId})` : ''}`);

      // R16：WS 消息限流（每连接 10 秒最多 30 条，防御脚本�刷消息）
      const now = Date.now();
      if (!ws._rateStart || now - ws._rateStart > 10000) {
        ws._rateStart = now;
        ws._rateCount = 0;
        ws._rateWarned = false;
      }
      ws._rateCount++;
      if (ws._rateCount > 30) {
        if (!ws._rateWarned) {
          ws._rateWarned = true;
          sendError(ws, '发送过于频繁，请稍后再试');
        }
        return;
      }

      try {
        switch (data.type) {
          case 'auth':
            handleAuth(ws, data, clientIp);
            break;
          case 'private_msg':
            handlePrivateMsg(ws, data);
            break;
          case 'group_msg':
            handleGroupMsg(ws, data);
            break;
          case 'file_msg':
            handleFileMsg(ws, data);
            break;
          case 'recall':
            handleRecall(ws, data);
            break;
          default:
            logger.warn(`WS 未知消息类型: ${data.type}`);
            sendError(ws, `未知消息类型: ${data.type}`);
        }
      } catch (err) {
        // 任何异常都不能让服务器崩溃，记录并告知客户端
        logger.error(`WS 消息处理异常: type=${data.type} error=${err.message}`);
        sendError(ws, `处理失败: ${err.message}`);
      }
    });

    ws.on('close', () => {
      // L5：连接关闭后清理未认证超时计时器，避免定时器空转
      if (ws._authTimer) { clearTimeout(ws._authTimer); ws._authTimer = null; }
      const uid = ws.userId;
      // 多开场景：仅当该连接仍是此用户的最新连接时才清理并广播离线
      if (uid && clients.get(uid) === ws) {
        const user = UserModel.findById(uid);
        if (user) {
          clients.delete(uid);
          logger.info(`WS 断开: userId=${uid} (${user.username})`);
          broadcastToFriends(uid, { type: 'friend_offline', userId: uid });
        }
      } else {
        logger.info(`WS 断开(未认证): ${clientIp}`);
      }
    });

    ws.on('error', (err) => {
      logger.error(`WS 错误: ${err.message}`);
    });
  });

  startHeartbeat(wss);
}

function handleAuth(ws, data, clientIp) {
  // F11：严格数字 ID（parseInt 会接受 "1abc"）
  const uid = parseId(data.userId);
  if (!uid) return sendError(ws, '无效的用户ID');

  const user = UserModel.findById(uid);
  if (!user) return sendError(ws, '用户不存在');

  // IP 身份验证：账号只能由注册 IP 或服务器本机连接
  if (!verifyAuthIp(clientIp, user)) {
    logger.warn(`WS 认证被拒（IP 不符）: userId=${uid} ip=${normalizeIp(clientIp)}`);
    return sendError(ws, '身份验证失败：该账号不属于当前设备 IP');
  }

  // H5：同一连接只允许绑定一个账号，防止重复 auth 造成身份残留与消息错投
  if (ws.userId && Number(ws.userId) !== uid) {
    logger.warn(`WS 重复认证被拒: 当前 userId=${ws.userId} 请求 userId=${uid}`);
    return sendError(ws, '该连接已认证为其他账号，请重新建立连接');
  }

  // 同账号多开：踢掉旧连接，避免在线状态与消息投递错乱
  const old = clients.get(uid);
  if (old && old !== ws && old.readyState === 1) {
    logger.info(`WS 重复登录: userId=${uid} 踢掉旧连接`);
    try {
      // 先告知旧连接"被顶替"，让客户端停止自动重连，避免两端互踢死循环
      old.send(JSON.stringify({ type: 'kicked', userId: uid }));
      old.close();
    } catch {}
  }

  ws.userId = uid;
  if (ws._authTimer) { clearTimeout(ws._authTimer); ws._authTimer = null; }
  clients.set(uid, ws);
  logger.info(`WS 认证成功: userId=${uid} username=${user.username} ip=${clientIp}`);

  ws.send(JSON.stringify({ type: 'authenticated', userId: uid }));

  broadcastToFriends(uid, { type: 'friend_online', userId: uid });
  logger.info(`WS 广播上线: userId=${uid}`);

  const onlineIds = Array.from(clients.keys());
  ws.send(JSON.stringify({ type: 'online_users', userIds: onlineIds }));
}

function handlePrivateMsg(ws, data) {
  const senderId = ws.userId;
  const { receiverId, content } = data;

  if (!senderId || !receiverId || typeof content !== 'string') {
    logger.warn(`WS 私聊参数不完整: senderId=${senderId} receiverId=${receiverId}`);
    return sendError(ws, '参数不完整');
  }
  // R7：去除控制字符（保留 \t \n），防终端注入/日志污染
  const text = stripControl(content).trim();
  if (!text) {
    return sendError(ws, '参数不完整');
  }
  // M3：服务端长度限制（前端 maxlength 可被绕过）
  if (text.length > MESSAGE_MAX) {
    return sendError(ws, `消息过长（最多 ${MESSAGE_MAX} 字）`);
  }

  const receiver = UserModel.findById(Number(receiverId));
  if (!receiver) {
    logger.warn(`WS 私聊接收者不存在: senderId=${senderId} receiverId=${receiverId}`);
    return sendError(ws, '接收者不存在');
  }

  // M2：仅好友之间允许私聊（防止任意用户骚扰/垃圾消息）
  const rel = FriendModel.getRelationship(senderId, Number(receiverId));
  if (!rel || rel.status !== 'accepted') {
    logger.warn(`WS 私聊非好友被拒: senderId=${senderId} receiverId=${receiverId}`);
    return sendError(ws, '你们还不是好友，无法发送消息');
  }

  // R5：拉黑双向生效
  if (BlockModel.isBlockedBy(senderId, Number(receiverId))) {
    logger.warn(`WS 私聊被拉黑: senderId=${senderId} receiverId=${receiverId}`);
    return sendError(ws, '消息发送失败：对方已将你拉黑');
  }
  if (BlockModel.isBlockedBy(Number(receiverId), senderId)) {
    logger.warn(`WS 私聊拉黑对方被拒: senderId=${senderId} receiverId=${receiverId}`);
    return sendError(ws, '消息发送失败：你已拉黑对方，请先取消拉黑');
  }

  const msg = MessageModel.create({
    type: 'private',
    senderId,
    receiverId,
    content: text,
  });

  logger.info(`WS 私聊消息: from=${senderId} to=${receiverId} msgId=${msg.id}`);

  const payload = { type: 'new_private_msg', message: msg };

  const receiverWs = clients.get(Number(receiverId));
  if (receiverWs && receiverWs.readyState === 1) {
    receiverWs.send(JSON.stringify(payload));
    logger.info(`WS 私聊已送达: msgId=${msg.id} to=${receiverId}`);
  }

  ws.send(JSON.stringify(payload));
}

function handleGroupMsg(ws, data) {
  const senderId = ws.userId;
  const { groupId, content } = data;

  if (!senderId || !groupId || typeof content !== 'string') {
    logger.warn(`WS 群聊参数不完整: senderId=${senderId} groupId=${groupId}`);
    return sendError(ws, '参数不完整');
  }
  // R7：去除控制字符（保留 \t \n）
  const text = stripControl(content).trim();
  if (!text) {
    return sendError(ws, '参数不完整');
  }
  // M3：服务端长度限制
  if (text.length > MESSAGE_MAX) {
    return sendError(ws, `消息过长（最多 ${MESSAGE_MAX} 字）`);
  }

  const group = GroupModel.getById(groupId);
  if (!group) {
    logger.warn(`WS 群聊群不存在: senderId=${senderId} groupId=${groupId}`);
    return sendError(ws, '群聊不存在');
  }

  if (!GroupModel.getMemberRole(groupId, senderId)) {
    logger.warn(`WS 群聊非成员发送被拒: senderId=${senderId} groupId=${groupId}`);
    return sendError(ws, '你不是该群成员，无法发送消息');
  }

  const msg = MessageModel.create({
    type: 'group',
    senderId,
    groupId,
    content: text,
  });

  logger.info(`WS 群聊消息: from=${senderId} groupId=${groupId} msgId=${msg.id}`);

  const payload = { type: 'new_group_msg', message: msg };
  const members = GroupModel.getMembers(groupId);

  const atNotices = members.filter(
    (member) => Number(member.id) !== Number(senderId) && isMentioned(text, member.username)
  );

  let sentCount = 0;

  for (const member of members) {
    if (Number(member.id) === Number(senderId) || GroupModel.isMuted(member.id, groupId)) continue;
    const memberWs = clients.get(Number(member.id));
    if (memberWs && memberWs.readyState === 1) {
      memberWs.send(JSON.stringify(payload));
      sentCount++;
    }
  }

  // 回显给发送者，保证发送端能立即看到自己发出的消息（与私聊行为一致）
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }

  for (const notice of atNotices) {
    if (GroupModel.isMuted(notice.id, groupId)) continue;
    const memberWs = clients.get(Number(notice.id));
    if (memberWs && memberWs.readyState === 1) {
      memberWs.send(JSON.stringify({
        type: 'mention',
        groupId,
        from: { id: senderId, username: msg.sender_name },
        content: text,
      }));
    }
  }

  if (atNotices.length) {
    logger.info(`WS @提及: msgId=${msg.id} groupId=${groupId} users=${atNotices.map((m) => m.username).join(',')}`);
  }

  logger.info(`WS 群聊已送达: msgId=${msg.id} groupId=${groupId} sent=${sentCount + 1}/${members.length + 1}`);
}

function handleFileMsg(ws, data) {
  const senderId = ws.userId;
  const { receiverId, groupId, fileId } = data;

  if (!senderId || !fileId) {
    logger.warn(`WS 文件消息参数不完整: senderId=${senderId} fileId=${fileId}`);
    return sendError(ws, '参数不完整');
  }

  const file = FileModel.getById(fileId);
  if (!file) {
    logger.warn(`WS 文件消息文件不存在: fileId=${fileId}`);
    return sendError(ws, '文件不存在');
  }

  // H1：只允许发送自己上传的文件，防止引用他人文件 ID 越权获取/转发
  if (Number(file.uploader_id) !== Number(senderId)) {
    logger.warn(`WS 文件消息非上传者被拒: senderId=${senderId} fileId=${fileId} uploader=${file.uploader_id}`);
    return sendError(ws, '无权发送该文件');
  }

  if (groupId) {
    const group = GroupModel.getById(groupId);
    if (!group) return sendError(ws, '群聊不存在');
    if (!GroupModel.getMemberRole(groupId, senderId)) {
      logger.warn(`WS 文件消息非成员发送被拒: senderId=${senderId} groupId=${groupId}`);
      return sendError(ws, '你不是该群成员，无法发送文件');
    }
  } else {
    if (!receiverId) return sendError(ws, '缺少接收者');
    if (!UserModel.findById(Number(receiverId))) return sendError(ws, '接收者不存在');
    // M2：私聊文件同样要求好友关系
    const rel = FriendModel.getRelationship(senderId, Number(receiverId));
    if (!rel || rel.status !== 'accepted') {
      return sendError(ws, '你们还不是好友，无法发送文件');
    }
    if (BlockModel.isBlockedBy(senderId, Number(receiverId))) {
      return sendError(ws, '消息发送失败：对方已将你拉黑');
    }
    // R5：拉黑双向生效
    if (BlockModel.isBlockedBy(Number(receiverId), senderId)) {
      return sendError(ws, '消息发送失败：你已拉黑对方，请先取消拉黑');
    }
  }

  const msgData = {
    type: groupId ? 'group' : 'private',
    senderId,
    receiverId: receiverId || null,
    groupId: groupId || null,
    content: file.original_name,
    fileId,
  };

  const msg = MessageModel.create(msgData);
  logger.info(`WS 文件消息: from=${senderId} fileId=${fileId} ${groupId ? `group=${groupId}` : `to=${receiverId}`} msgId=${msg.id}`);

  const payload = { type: 'new_file_msg', message: msg };

  if (groupId) {
    const members = GroupModel.getMembers(groupId);
    let sentCount = 0;
    for (const member of members) {
      if (Number(member.id) === Number(senderId) || GroupModel.isMuted(member.id, groupId)) continue;
      const memberWs = clients.get(Number(member.id));
      if (memberWs && memberWs.readyState === 1) {
        memberWs.send(JSON.stringify(payload));
        sentCount++;
      }
    }
    logger.info(`WS 文件群聊已送达: msgId=${msg.id} groupId=${groupId} sent=${sentCount + 1}/${members.length + 1}`);

    // 回显给发送者，保证发送端能立即看到自己发出的文件消息
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
    }
  } else {
    const receiverWs = clients.get(Number(receiverId));
    if (receiverWs && receiverWs.readyState === 1) {
      receiverWs.send(JSON.stringify(payload));
    }
    ws.send(JSON.stringify(payload));
  }
}

function startHeartbeat(wss) {
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        // 直接 terminate，由 close 处理器统一清理 clients 与广播下线
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);
  wss.on('close', () => clearInterval(interval));
}

function handleRecall(ws, data) {
  const uid = ws.userId;
  const { messageId } = data;

  if (!messageId) return sendError(ws, '缺少消息ID');

  const msg = MessageModel.recall(messageId, uid);
  if (!msg) {
    logger.warn(`WS 撤回失败: messageId=${messageId} userId=${uid}`);
    return sendError(ws, '撤回失败（超过2分钟或非发送者）');
  }

  logger.info(`WS 撤回消息: messageId=${messageId} userId=${uid} type=${msg.type}`);

  const payload = { type: 'msg_recalled', message: msg };

  if (msg.type === 'private') {
    const receiverWs = clients.get(Number(msg.receiver_id));
    if (receiverWs && receiverWs.readyState === 1) {
      receiverWs.send(JSON.stringify(payload));
    }
  } else if (msg.type === 'group') {
    const members = GroupModel.getMembers(msg.group_id);
    for (const member of members) {
      if (GroupModel.isMuted(member.id, msg.group_id)) continue;
      const memberWs = clients.get(Number(member.id));
      if (memberWs && memberWs.readyState === 1) {
        memberWs.send(JSON.stringify(payload));
      }
    }
  }

  ws.send(JSON.stringify(payload));
}

function broadcastToFriends(uid, payload) {
  const friends = FriendModel.getFriends(uid);
  const json = JSON.stringify(payload);

  for (const friend of friends) {
    const friendWs = clients.get(Number(friend.id));
    if (friendWs && friendWs.readyState === 1) {
      friendWs.send(json);
    }
  }
}

function sendError(ws, message) {
  if (ws.readyState !== 1) return;
  // 仅限流未认证连接（认证用户的错误是正常业务反馈，不应丢失）
  if (!ws.userId) {
    const now = Date.now();
    if (ws._lastErrAt && now - ws._lastErrAt < 5000) return;
    ws._lastErrAt = now;
  }
  ws.send(JSON.stringify({ type: 'error', message }));
}

function notifyFriendRequest(userId, friendId) {
  const friendWs = clients.get(Number(friendId));
  if (friendWs && friendWs.readyState === 1) {
    const user = UserModel.findById(userId);
    friendWs.send(
      JSON.stringify({
        type: 'friend_request',
        from: { id: user.id, ip: user.ip, username: user.username },
      })
    );
  }
}

function notifyRequestHandled(friendId, userId, status) {
  const friendWs = clients.get(Number(friendId));
  if (friendWs && friendWs.readyState === 1) {
    const user = UserModel.findById(userId);
    friendWs.send(
      JSON.stringify({
        type: 'request_handled',
        by: { id: user.id, ip: user.ip, username: user.username },
        status,
      })
    );
  }
}

function notifyNewFriend(userId, friendId) {
  const friendWs = clients.get(Number(friendId));
  if (friendWs && friendWs.readyState === 1) {
    const user = UserModel.findById(userId);
    friendWs.send(
      JSON.stringify({
        type: 'new_friend',
        user: { id: user.id, ip: user.ip, username: user.username },
      })
    );
  }
}

function notifyFriendRemoved(userId, friendId) {
  const friendWs = clients.get(Number(friendId));
  if (friendWs && friendWs.readyState === 1) {
    const user = UserModel.findById(userId);
    friendWs.send(
      JSON.stringify({
        type: 'friend_removed',
        by: user ? { id: user.id, ip: user.ip, username: user.username } : { id: userId },
      })
    );
  }
}

// F9：群成员/群删除实时通知
function notifyUser(userId, payload) {
  const ws = clients.get(Number(userId));
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function notifyGroupMemberAdded(userId, group) {
  notifyUser(userId, { type: 'group_added', group });
}

function notifyGroupMemberRemoved(userId, groupId) {
  notifyUser(userId, { type: 'group_removed', groupId });
}

function notifyGroupDeleted(memberIds, groupId, groupName) {
  for (const uid of new Set(memberIds.map(Number))) {
    notifyUser(uid, { type: 'group_deleted', groupId, groupName });
  }
}

module.exports = {
  setupWebSocket,
  notifyFriendRequest,
  notifyRequestHandled,
  notifyNewFriend,
  notifyFriendRemoved,
  notifyGroupMemberAdded,
  notifyGroupMemberRemoved,
  notifyGroupDeleted,
  clients,
};
