"use strict";

const initSqlJs = require("sql.js");

let db = null;

const initDB = initSqlJs().then((SQL) => {
    db = new Database(); // чисто в памяти, без файла
    
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
    
    console.log("SQLite (in-memory): схема готова");
    return db;
});

const dbWrapper = {
    run(sql, params = []) {
        try {
            db.run(sql, params);
            const changes = db.getChanges();
            const lastId = db.exec("SELECT last_insert_rowid()")[0].values[0][0];
            return { changes: changes, lastInsertRowid: lastId };
        } catch (e) {
            console.error("DB RUN ERROR:", e.message, sql);
            throw e;
        }
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
    saveNow() { /* noop - in memory */ }
};

module.exports = { db: dbWrapper, dbReady: initDB };
