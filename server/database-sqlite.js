"use strict";

// Простая in-memory база (без sql.js, без файлов — чистый JS)
let nextUserId = 1;
let nextRequestId = 1;
let nextMessageId = 1;
let nextFriendId = 1;

const users = new Map();
const sessions = new Map();
const friendRequests = new Map();
const friends = new Map();
const messages = new Map();

const db = {
    run(sql, params = []) {
        const sql_lower = sql.trim().toLowerCase();
        
        // DELETE FROM sessions — clean expired or old sessions
        if (sql_lower.startsWith("delete from sessions")) {
            if (sql_lower.includes("expires_at") || sql_lower.includes("token not in")) {
                for (const [token, sess] of sessions) {
                    if (!sess.expires_at || new Date(sess.expires_at) <= new Date()) {
                        sessions.delete(token);
                    }
                }
            } else if (sql_lower.includes("token =") || sql_lower.includes("token=")) {
                // Delete specific session by token (params[0] is the token hash)
                for (const [token] of sessions) {
                    if (token === params[0]) { sessions.delete(token); break; }
                }
            } else if (sql_lower.includes("user_id =") || sql_lower.includes("user_id=")) {
                // Delete all sessions for a user (not currently used but safe)
                for (const [token, sess] of sessions) {
                    if (Number(sess.user_id) === Number(params[0])) sessions.delete(token);
                }
            }
            return { changes: 1, lastInsertRowid: 0 };
        }
        
        // INSERT INTO users
        if (sql_lower.startsWith("insert into users")) {
            const id = nextUserId++;
            users.set(id, { id, username: params[0], password: params[1], avatar: "", created_at: new Date().toISOString(), last_seen: null });
            return { changes: 1, lastInsertRowid: id };
        }
        
        // INSERT INTO sessions
        if (sql_lower.startsWith("insert into sessions")) {
            sessions.set(params[0], { token: params[0], user_id: params[1], created_at: new Date().toISOString(), expires_at: params[2] });
            return { changes: 1, lastInsertRowid: 0 };
        }
        
        // INSERT INTO friend_requests
        if (sql_lower.startsWith("insert into friend_requests")) {
            const id = nextRequestId++;
            friendRequests.set(id, { id, sender_id: params[0], receiver_id: params[1], status: "pending", created_at: new Date().toISOString() });
            return { changes: 1, lastInsertRowid: id };
        }
        
        // INSERT INTO friends (also handles INSERT OR IGNORE INTO friends)
        if (sql_lower.startsWith("insert") && sql_lower.includes("into friends")) {
            const key = `${params[0]}_${params[1]}`;
            if (friends.has(key)) return { changes: 0, lastInsertRowid: 0 }; // INSERT OR IGNORE
            const id = nextFriendId++;
            friends.set(key, { id, user_id: params[0], friend_id: params[1], created_at: new Date().toISOString() });
            return { changes: 1, lastInsertRowid: id };
        }
        
        // INSERT INTO messages
        if (sql_lower.startsWith("insert") && sql_lower.includes("into messages")) {
            const id = nextMessageId++;
            const msg = {
                id, sender_id: params[0], receiver_id: params[1], text: params[2] || "",
                message_type: params[3] || "text", file_name: params[4] || "",
                file_url: params[5] || "", file_size: params[6] || 0, is_read: 0,
                created_at: new Date().toISOString()
            };
            messages.set(id, msg);
            return { changes: 1, lastInsertRowid: id };
        }
        
        // UPDATE users SET username
        if (sql_lower.startsWith("update users set username")) {
            const u = users.get(Number(params[1]));
            if (u) u.username = params[0];
            return { changes: u ? 1 : 0, lastInsertRowid: 0 };
        }
        
        // UPDATE users SET last_seen
        if (sql_lower.startsWith("update users set last_seen")) {
            const u = users.get(Number(params[1]));
            if (u) u.last_seen = params[0];
            return { changes: u ? 1 : 0, lastInsertRowid: 0 };
        }
        
        // UPDATE friend_requests SET status
        if (sql_lower.startsWith("update friend_requests set status")) {
            let changes = 0;
            for (const [id, req] of friendRequests) {
                if (req.id === Number(params[1]) || id === Number(params[1])) {
                    // Determine new status from SQL — default to whatever the SQL says
                    if (sql_lower.includes("'accepted'") || sql_lower.includes("\"accepted\"")) req.status = "accepted";
                    else if (sql_lower.includes("'rejected'") || sql_lower.includes("\"rejected\"")) req.status = "rejected";
                    else req.status = "accepted"; // default
                    changes = 1;
                    break;
                }
            }
            return { changes, lastInsertRowid: 0 };
        }
        
        // UPDATE messages SET is_read
        if (sql_lower.startsWith("update messages set is_read")) {
            let changes = 0;
            for (const [, msg] of messages) {
                if (Number(msg.sender_id) === Number(params[0]) && Number(msg.receiver_id) === Number(params[1]) && msg.is_read === 0) {
                    msg.is_read = 1; changes++;
                }
            }
            return { changes, lastInsertRowid: 0 };
        }
        
        // DELETE FROM friends (handles both single and OR conditions)
        if (sql_lower.startsWith("delete from friends")) {
            if (sql_lower.includes(" or ")) {
                // DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
                const uid = Number(params[0]); const fid = Number(params[1]);
                const uid2 = Number(params[2]); const fid2 = Number(params[3]);
                friends.delete(`${uid}_${fid}`);
                friends.delete(`${fid}_${uid}`);
                friends.delete(`${uid2}_${fid2}`);
                friends.delete(`${fid2}_${uid2}`);
            } else {
                // DELETE FROM friends WHERE user_id = ? AND friend_id = ?
                const uid = Number(params[0]); const fid = Number(params[1]);
                friends.delete(`${uid}_${fid}`);
                friends.delete(`${fid}_${uid}`);
            }
            return { changes: 1, lastInsertRowid: 0 };
        }
        
        // DELETE FROM messages
        if (sql_lower.startsWith("delete from messages")) {
            messages.delete(Number(params[0]));
            return { changes: 1, lastInsertRowid: 0 };
        }
        
        // DELETE FROM friend_requests
        if (sql_lower.startsWith("delete from friend_requests")) {
            if (sql_lower.includes(" or ")) {
                // DELETE FROM friend_requests WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
                for (const [id, req] of friendRequests) {
                    if ((Number(req.sender_id) === Number(params[0]) && Number(req.receiver_id) === Number(params[1])) ||
                        (Number(req.sender_id) === Number(params[2]) && Number(req.receiver_id) === Number(params[3]))) {
                        friendRequests.delete(id);
                    }
                }
            } else {
                // Simple delete by id or condition
                for (const [id, req] of friendRequests) {
                    if (req.id === Number(params[0]) || req.sender_id === Number(params[0])) {
                        friendRequests.delete(id);
                    }
                }
            }
            return { changes: 1, lastInsertRowid: 0 };
        }
        
        return { changes: 0, lastInsertRowid: 0 };
    },
    
    get(sql, params = []) {
        const sql_lower = sql.trim().toLowerCase();
        
        // SELECT 1 FROM users WHERE username = ?
        if (sql_lower.startsWith("select 1 from users where username")) {
            for (const u of users.values()) {
                if (u.username.toLowerCase() === String(params[0]).toLowerCase()) return { 1: 1 };
            }
            return null;
        }
        
        // SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?
        if (sql_lower.startsWith("select 1 from friends")) {
            const uid = Number(params[0]); const fid = Number(params[1]);
            return friends.has(`${uid}_${fid}`) ? { 1: 1 } : null;
        }
        
        // SELECT 1 FROM friend_requests WHERE sender_id = ? AND receiver_id = ? AND status = 'pending'
        if (sql_lower.startsWith("select 1 from friend_requests where sender_id")) {
            for (const r of friendRequests.values()) {
                if (Number(r.sender_id) === Number(params[0]) && Number(r.receiver_id) === Number(params[1]) && r.status === "pending") return { id: 1 };
            }
            return null;
        }
        
        // SELECT * FROM friend_requests WHERE id = ? AND receiver_id = ? AND status = 'pending'
        if (sql_lower.startsWith("select * from friend_requests where id")) {
            for (const r of friendRequests.values()) {
                if (r.id === Number(params[0]) && Number(r.receiver_id) === Number(params[1]) && r.status === "pending") return r;
            }
            return null;
        }
        
        // SELECT id, status FROM friend_requests WHERE sender_id = ? AND receiver_id = ?
        if (sql_lower.startsWith("select id, status from friend_requests where sender_id")) {
            for (const r of friendRequests.values()) {
                if (Number(r.sender_id) === Number(params[0]) && Number(r.receiver_id) === Number(params[1])) return r;
            }
            return null;
        }
        
        // SELECT * FROM users WHERE username = ?
        if (sql_lower.startsWith("select * from users where username")) {
            for (const u of users.values()) {
                if (u.username.toLowerCase() === String(params[0]).toLowerCase()) return u;
            }
            return null;
        }
        
        // SELECT id, username, avatar FROM users WHERE id = ?
        if (sql_lower.startsWith("select id, username, avatar from users where id")) {
            return users.get(Number(params[0])) || null;
        }
        
        // SELECT id, username, avatar FROM messages WHERE id = ?  (also handles full message select)
        if (sql_lower.startsWith("select id, sender_id, receiver_id, text, message_type, file_name, file_url, file_size, is_read, created_at from messages where id")) {
            return messages.get(Number(params[0])) || null;
        }
        
        // SELECT id, sender_id, receiver_id FROM messages WHERE id = ?
        if (sql_lower.startsWith("select id, sender_id, receiver_id from messages where id")) {
            return messages.get(Number(params[0])) || null;
        }
        
        // SELECT users.id, ... (getUserByToken) — join sessions + users
        if (sql_lower.startsWith("select users.id")) {
            for (const [token, sess] of sessions) {
                if (token === params[0] && sess.expires_at && new Date(sess.expires_at) > new Date()) {
                    const u = users.get(sess.user_id);
                    if (u) return { id: u.id, username: u.username, avatar: u.avatar, session_hash: token };
                }
            }
            return null;
        }
        
        // SELECT 1 FROM users WHERE username = ? AND id != ?
        if (sql_lower.startsWith("select 1 from users where username = ? and id !=") || 
            sql_lower.startsWith("select 1 from users where username = ? and id !=")) {
            for (const u of users.values()) {
                if (u.username.toLowerCase() === String(params[0]).toLowerCase() && u.id !== Number(params[1])) return { 1: 1 };
            }
            return null;
        }
        
        // SELECT file_name FROM messages WHERE file_url = ? LIMIT 1
        if (sql_lower.startsWith("select file_name from messages where file_url")) {
            for (const m of messages.values()) {
                if (m.file_url === params[0]) return { file_name: m.file_name };
            }
            return null;
        }
        
        // SELECT 1 FROM messages WHERE file_url = ? AND (sender_id = ? OR receiver_id = ?) LIMIT 1
        if (sql_lower.startsWith("select 1 from messages where file_url")) {
            for (const m of messages.values()) {
                if (m.file_url === params[0] && (Number(m.sender_id) === Number(params[1]) || Number(m.receiver_id) === Number(params[2]))) return { 1: 1 };
            }
            return null;
        }
        
        return null;
    },
    
    all(sql, params = []) {
        const sql_lower = sql.trim().toLowerCase();
        
        // SELECT friend_id FROM friends WHERE user_id = ?
        if (sql_lower.startsWith("select friend_id from friends where user_id")) {
            const result = [];
            for (const f of friends.values()) {
                if (Number(f.user_id) === Number(params[0])) result.push({ friend_id: f.friend_id });
            }
            return result;
        }
        
        // SELECT u.id, u.username, u.avatar, ... — friends list OR user search
        if (sql_lower.startsWith("select u.id, u.username, u.avatar")) {
            // Check if this is the friends list query (contains "FROM friends f")
            if (sql_lower.includes("from friends f") || sql_lower.includes("from friends as f") || sql_lower.includes("from friends")) {
                // Friends list query
                const result = [];
                for (const f of friends.values()) {
                    if (Number(f.user_id) === Number(params[0])) {
                        const u = users.get(f.friend_id);
                        if (u) {
                            let lastMsg = null;
                            let lastMsgAt = null;
                            let unread = 0;
                            for (const m of messages.values()) {
                                if ((Number(m.sender_id) === Number(f.user_id) && Number(m.receiver_id) === u.id) ||
                                    (Number(m.sender_id) === u.id && Number(m.receiver_id) === Number(f.user_id))) {
                                    if (!lastMsgAt || m.created_at > lastMsgAt) {
                                        lastMsg = m.text; lastMsgAt = m.created_at;
                                    }
                                }
                                if (Number(m.sender_id) === u.id && Number(m.receiver_id) === Number(f.user_id) && m.is_read === 0) unread++;
                            }
                            result.push({ id: u.id, username: u.username, avatar: u.avatar, last_seen: u.last_seen || "", last_message: lastMsg || "", last_message_at: lastMsgAt || "", unread_count: unread });
                        }
                    }
                }
                result.sort((a, b) => (b.last_message_at || "").localeCompare(a.last_message_at || ""));
                return result;
            }
            // Otherwise: user search query
            // Params: [req.user.id, req.user.id, req.user.id, req.user.id, "%q%", q]
            const q = String(params[4] || "").replace(/%/g, "").toLowerCase();
            const myId = Number(params[0]);
            const result = [];
            for (const u of users.values()) {
                if (u.id !== Number(params[3]) && u.username.toLowerCase().includes(q)) {
                    let relation = "none";
                    if (friends.has(`${myId}_${u.id}`)) relation = "friend";
                    else {
                        for (const r of friendRequests.values()) {
                            if (Number(r.sender_id) === myId && Number(r.receiver_id) === u.id && r.status === "pending") { relation = "sent"; break; }
                            if (Number(r.sender_id) === u.id && Number(r.receiver_id) === myId && r.status === "pending") { relation = "received"; break; }
                        }
                    }
                    result.push({ id: u.id, username: u.username, avatar: u.avatar, relation });
                }
            }
            result.sort((a, b) => a.username.localeCompare(b.username));
            return result.slice(0, 20);
        }
        
        // SELECT r.id, u.id as user_id, ... — friend requests list
        if (sql_lower.startsWith("select r.id, u.id as user_id") || sql_lower.startsWith("select r.id, u.id as user_id")) {
            const result = [];
            for (const r of friendRequests.values()) {
                if (Number(r.receiver_id) === Number(params[0]) && r.status === "pending") {
                    const u = users.get(r.sender_id);
                    if (u) result.push({ id: r.id, user_id: u.id, username: u.username, avatar: u.avatar, created_at: r.created_at });
                }
            }
            result.sort((a, b) => b.created_at.localeCompare(a.created_at));
            return result;
        }
        
        // Messages history — SELECT * FROM (SELECT ... ) or SELECT id, sender_id, ...
        if (sql_lower.startsWith("select * from (") || sql_lower.startsWith("select id, sender_id")) {
            const uid = Number(params[0]); const oid = Number(params[1]);
            const before = params[4] ? Number(params[4]) : null;
            const result = [];
            for (const m of messages.values()) {
                if ((Number(m.sender_id) === uid && Number(m.receiver_id) === oid) ||
                    (Number(m.sender_id) === oid && Number(m.receiver_id) === uid)) {
                    if (before === null || m.id < before) result.push(m);
                }
            }
            result.sort((a, b) => b.id - a.id);
            const limited = result.slice(0, 100);
            limited.sort((a, b) => a.id - b.id);
            return limited;
        }
        
        return [];
    },
    
    saveNow() { /* noop — in-memory, nothing to save */ },
    
    // Helper for session cleanup — iterate all sessions
    _iterateSessions() {
        return sessions.entries();
    },
    
    // Helper for debugging
    _stats() {
        return {
            users: users.size,
            sessions: sessions.size,
            friendRequests: friendRequests.size,
            friends: friends.size,
            messages: messages.size
        };
    }
};

const dbReady = Promise.resolve(db);
console.log("In-memory JS database ready v2.2");

module.exports = { db, dbReady };
