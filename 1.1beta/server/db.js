const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const DB_PATH = path.join(__dirname, '..', 'data', 'chat.db');

let db;

function initDatabase() {
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new DatabaseSync(DB_PATH);
  logger.info(`数据库文件: ${DB_PATH}`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  logger.info('数据库 PRAGMA 配置完成');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      username TEXT NOT NULL,
      created_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS friends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      friend_id INTEGER NOT NULL,
      status TEXT CHECK(status IN ('pending','accepted')) DEFAULT 'pending',
      created_at DATETIME DEFAULT (datetime('now')),
      UNIQUE(user_id, friend_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (friend_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      creator_id INTEGER NOT NULL,
      announcement TEXT DEFAULT '',
      created_at DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (creator_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT CHECK(role IN ('member','admin')) DEFAULT 'member',
      joined_at DATETIME DEFAULT (datetime('now')),
      UNIQUE(group_id, user_id),
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT CHECK(type IN ('private','group')) NOT NULL,
      sender_id INTEGER NOT NULL,
      receiver_id INTEGER,
      group_id INTEGER,
      content TEXT NOT NULL,
      status TEXT CHECK(status IN ('sent','recalled')) DEFAULT 'sent',
      created_at DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (sender_id) REFERENCES users(id),
      FOREIGN KEY (receiver_id) REFERENCES users(id),
      FOREIGN KEY (group_id) REFERENCES groups(id)
    );

    CREATE TABLE IF NOT EXISTS blocked_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      blocked_user_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT (datetime('now')),
      UNIQUE(user_id, blocked_user_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (blocked_user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_blocked_users_user ON blocked_users(user_id);

    CREATE INDEX IF NOT EXISTS idx_messages_private
      ON messages(type, sender_id, receiver_id);
    CREATE INDEX IF NOT EXISTS idx_messages_group
      ON messages(type, group_id);
    CREATE INDEX IF NOT EXISTS idx_friends_user
      ON friends(user_id);
    CREATE INDEX IF NOT EXISTS idx_group_members_group
      ON group_members(group_id);
    CREATE INDEX IF NOT EXISTS idx_group_members_user
      ON group_members(user_id);

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      uploader_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (uploader_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS group_mutes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      group_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT (datetime('now')),
      UNIQUE(user_id, group_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_group_mutes_user ON group_mutes(user_id);
  `);

  try { db.exec('ALTER TABLE messages ADD COLUMN file_id INTEGER REFERENCES files(id)'); } catch {}

  try { db.exec('ALTER TABLE groups ADD COLUMN announcement TEXT DEFAULT \'\''); } catch {}

  try { db.exec('ALTER TABLE group_members ADD COLUMN role TEXT CHECK(role IN (\'member\',\'admin\')) DEFAULT \'member\''); } catch {}

  migrateUsersTable();

  logger.info('数据库表结构初始化完成');
  return db;
}

function migrateUsersTable() {
  try {
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
    if (tableInfo && tableInfo.sql.includes('ip TEXT UNIQUE')) {
      logger.info('迁移 users 表: 移除 ip UNIQUE 约束');
      db.exec('CREATE TABLE users_new (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, username TEXT NOT NULL, created_at DATETIME DEFAULT (datetime(\'now\')))');
      db.exec('INSERT INTO users_new (id, ip, username, created_at) SELECT id, ip, username, created_at FROM users');
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
      logger.info('users 表迁移完成');
    }
  } catch (err) {
    logger.warn(`users 表迁移跳过: ${err.message}`);
  }

  try {
    const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='group_members'").get();
    if (info && !info.sql.includes('role')) {
      db.exec("ALTER TABLE group_members ADD COLUMN role TEXT CHECK(role IN ('member','admin')) DEFAULT 'member'");
    }
  } catch {}
}

function getDb() {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

module.exports = { initDatabase, getDb };
