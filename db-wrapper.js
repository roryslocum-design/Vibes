const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

let SQL;
let db;
let dbPath;

class PreparedStatement {
  constructor(sql, database) {
    this.sql = sql;
    this.db = database;
  }

  get(...params) {
    const stmt = this.db.prepare(this.sql);
    stmt.bind(params);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  }

  all(...params) {
    const stmt = this.db.prepare(this.sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  run(...params) {
    const stmt = this.db.prepare(this.sql);
    stmt.bind(params);
    stmt.step();
    stmt.free();
    saveDb();
    return { changes: this.db.getRowsModified() };
  }
}

function saveDb() {
  if (db && dbPath) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
}

function loadDb() {
  if (dbPath && fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    return new Uint8Array(buffer);
  }
  return null;
}

async function initDb(path) {
  dbPath = path;
  if (!SQL) {
    SQL = await initSqlJs();
  }
  
  const existing = loadDb();
  if (existing) {
    db = new SQL.Database(existing);
  } else {
    db = new SQL.Database();
  }
  
  return {
    prepare: (sql) => new PreparedStatement(sql, db),
    exec: (sql) => {
      db.run(sql);
      saveDb();
    },
    transaction: (fn) => ({
      run: () => {
        db.run('BEGIN TRANSACTION');
        try {
          fn();
          db.run('COMMIT');
          saveDb();
        } catch (e) {
          db.run('ROLLBACK');
          throw e;
        }
      }
    }),
    getRowsModified: () => db.getRowsModified(),
    close: () => {
      saveDb();
      db.close();
    }
  };
}

module.exports = { initDb };
