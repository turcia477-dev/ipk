"use strict";

const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");

const dataDir = process.env.IPK_DATA_DIR || "/tmp/ipk-data";
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, "ipk.db");

let db = null;
let saveTimer = null;

const initDB = initSqlJs().then((SQL) => {
    let buffer = null;
    if (fs.existsSync(dbPath)) {
        buffer = fs.readFileSync(dbPath);
    }
    db = new SQL.Database(buffer);
    
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password TEXT NOT NULL,
            avatar TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_seen TEXT
        );
    `);
    db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `);
    db.run(`
        CREATE TABLE IF NOT EXISTS friend_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id INTEGER NOT NULL,
            receiver_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(sender_id, receiver_id)
        );
    `);
    db.run(`
        CREATE TABLE IF NOT EXISTS friends (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            friend_id INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(user_id, friend_id)
        );
    `);
    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id INTEGER NOT NULL,
            receiver_id INTEGER NOT NULL,
            text TEXT NOT NULL DEFAULT '',
            message_type TEXT NOT NULL DEFAULT 'text',
            file_name TEXT NOT NULL DEFAULT '',
            file_url TEXT NOT NULL DEFAULT '',
            file_size INTEGER NOT NULL DEFAULT 0,
            is_read INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `);
    
    db.run("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);");
    db.run("CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);");
    db.run("CREATE INDEX IF NOT EXISTS idx_requests_receiver_status ON friend_requests(receiver_id, status, created_at);");
    db.run("CREATE INDEX IF NOT EXISTS idx_requests_sender_status ON friend_requests(sender_id, status, created_at);");
    db.run("CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id, friend_id);");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_sender_receiver_id ON messages(sender_id, receiver_id, id);");
    db.run("CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(receiver_id, sender_id, is_read, id);");
    
    db.run("DELETE FROM sessions WHERE expires_at IS NULL OR expires_at <= datetime('now')");
    
    saveDB();
    console.log("SQLite (sql.js): схема готова, БД в", dbPath);
    return db;
});

function saveDB() {
    if (!db) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            const data = db.export();
            fs.writeFileSync(dbPath, Buffer.from(data));
        } catch (e) {
            console.error("DB SAVE ERROR:", e.message);
        }
    }, 2000);
}

const dbWrapper = {
    run(sql, params = []) {
        db.run(sql, params);
        saveDB();
        const result = db.getChanges();
        return { changes: result, lastInsertRowid: db.exec("SELECT last_insert_rowid()")[0].values[0][0] };
    },
    get(sql, params = []) {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        let row = null;
        if (stmt.step()) {
            row = stmt.getAsObject();
        }
        stmt.free();
        return row;
    },
    all(sql, params = []) {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) {
            rows.push(stmt.getAsObject());
        }
        stmt.free();
        return rows;
    },
    saveNow() {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        if (db) {
            const data = db.export();
            fs.writeFileSync(dbPath, Buffer.from(data));
        }
    }
};

module.exports = { db: dbWrapper, dbReady: initDB };
