"use strict";

const { Pool } = require("pg");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
});

// --- DB abstraction layer (PostgreSQL) ---
const db = {
    async query(text, params) {
        const client = await pool.connect();
        try {
            const result = await client.query(text, params);
            return result;
        } finally {
            client.release();
        }
    },

    // Sync-like wrappers for compatibility
    async _run(text, params) {
        const result = await this.query(text, params);
        return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id };
    },

    async _get(text, params) {
        const result = await this.query(text, params);
        return result.rows[0] || null;
    },

    async _all(text, params) {
        const result = await this.query(text, params);
        return result.rows;
    }
};

// --- Init schema ---
async function initDB() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL UNIQUE COLLATE "C",
            password TEXT NOT NULL,
            avatar TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen TIMESTAMPTZ
        );
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ
        );
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS friend_requests (
            id SERIAL PRIMARY KEY,
            sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(sender_id, receiver_id)
        );
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS friends (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(user_id, friend_id)
        );
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            text TEXT NOT NULL DEFAULT '',
            message_type TEXT NOT NULL DEFAULT 'text',
            file_name TEXT NOT NULL DEFAULT '',
            file_url TEXT NOT NULL DEFAULT '',
            file_size INTEGER NOT NULL DEFAULT 0,
            is_read INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_requests_receiver_status ON friend_requests(receiver_id, status, created_at);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_requests_sender_status ON friend_requests(sender_id, status, created_at);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id, friend_id);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_messages_sender_receiver_id ON messages(sender_id, receiver_id, id);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(receiver_id, sender_id, is_read, id);`);
    // Clean expired sessions
    await db.query("DELETE FROM sessions WHERE expires_at IS NULL OR expires_at <= NOW()");
    console.log("PostgreSQL: схема готова");
}

// Promisified init — server waits for this
const dbReady = initDB();

module.exports = { db, dbReady, pool };
