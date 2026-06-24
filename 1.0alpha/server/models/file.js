const { getDb } = require('../db');

class FileModel {
  static create(originalName, storedName, mimeType, size, uploaderId) {
    const stmt = getDb().prepare(`
      INSERT INTO files (original_name, stored_name, mime_type, size, uploader_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(originalName, storedName, mimeType, size, uploaderId);
    return this.getById(result.lastInsertRowid);
  }

  static getById(id) {
    return getDb()
      .prepare('SELECT * FROM files WHERE id = ?')
      .get(id);
  }
}

module.exports = FileModel;
