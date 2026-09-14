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
        const sql_lower = sql.trim().toUpperCase();
        
        if (sql_lower.startsWith("DELETE FROM SESSIONS")) {
            if (sql.includes("expires_at") || sql.includes("token NOT IN")) {
                // Clean expired or old sessions
                for (const [token, sess] of sessions) {
                    if (!sess.expires_at || new Date(sess.expires_at) <= new Date()) {
                        sessions.delete(token);
                    }
                }
            } else if (sql.includes("token =")) {
                sessions.delete(params[0]);
            }
            return { changes: 1, lastInsertRowid: 0 };
        }
        
        if (sql_lower.startsWith("INSERT INTO USERS")) {
            const id = nextUserId++;
            users.set(id, { id, username: params[0], password: params[1], avatar: "", created_at: new Date().toISOString(), last_seen: null });
            return { changes: 1, lastInsertRowid: id };
        }
        
        if (sql_lower.startsWith("INSERT INTO SESSIONS")) {
            sessions.set(params[0], { token: params[0], user_id: params[1], created_at: new Date().toISOString(), expires_at: params[2] });
            return { changes: 1, lastInsertRowid: 0 };
        }
        
        if (sql_lower.startsWith("INSERT INTO FRIEND_REQUESTS")) {
            const id = nextRequestId++;
            friendRequests.set(id, { id, sender_id: params[0], receiver_id: params[1], status: "pending", created_at: new Date().toISOString() });
            return { changes: 1, lastInsertRowid: id };
        }
        
        if (sql_lower.startsWith("INSERT") && sql_lower.includes("INTO FRIENDS")) {
            const id = nextFriendId++;
            friends.set(`${params[0]}_${params[1]}`, { id, user_id: params[0], friend_id: params[1], created_at: new Date().toISOString() });
            return { changes: 1, lastInsertRowid: id };
        }
        
        if (sql_lower.startsWith("INSERT") && sql_lower.includes("INTO MESSAGES")) {
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
        
        if (sql_lower.startsWith("UPDATE USERS SET USERNAME")) {
            const u = users.get(params[1]);
            if (u) u.username = params[0];
            return { changes: u ? 1 : 0, lastInsertRowid: 0 };
        }
        
        if (sql_lower.startsWith("UPDATE USERS SET LAST_SEEN")) {
            const u = users.get(params[1]);
            if (u) u.last_seen = params[0];
            return { changes: u ? 1 : 0, lastInsertRowid: 0 };
        }
        
        if (sql_lower.startsWith("UPDATE FRIEND_REQUESTS SET STATUS")) {
            let changes = 0;
            for (const [id, req] of friendRequests) {
                if (req.id === params[1]) { req.status = "accepted"; changes = 1; break; }
            }
            return { changes, lastInsertRowid: 0 };
        }
        
        if (sql_lower.startsWith("UPDATE MESSAGES SET IS_READ")) {
            let changes = 0;
            for (const [id, msg] of messages) {
                if (Number(msg.sender_id) === Number(params[0]) && Number(msg.receiver_id) === Number(params[1]) && msg.is_read === 0) {
                    msg.is_read = 1; changes++;
                }
            }
            return { changes, lastInsertRowid: 0 };
        }
        
        if (sql_lower.startsWith("DELETE FROM FRIENDS")) {
            const uid = Number(params[0]); const fid = Number(params[1]);
            friends.delete(`${uid}_${fid}`);
            friends.delete(`${fid}_${uid}`);
            for (const [id, req] of friendRequests) {
                if ((Number(req.sender_id) === uid && Number(req.receiver_id) === fid) ||
                    (Number(req.sender_id) === fid && Number(req.receiver_id) === uid)) {
                    friendRequests.delete(id);
                }
            }
            return { changes: 1, lastInsertRowid: 0 };
        }
        
        if (sql_lower.startsWith("DELETE FROM MESSAGES")) {
            messages.delete(Number(params[0]));
            return { changes: 1, lastInsertRowid: 0 };
        }
        
        if (sql_lower.startsWith("DELETE FROM FRIEND_REQUESTS")) {
            // noop for simplicity
            return { changes: 1, lastInsertRowid: 0 };
        }
        
        return { changes: 0, lastInsertRowid: 0 };
    },
    
    get(sql, params = []) {
        const sql_lower = sql.trim().toUpperCase();
        
        if (sql_lower.startsWith("SELECT 1 FROM USERS WHERE USERNAME")) {
            for (const u of users.values()) {
                if (u.username.toLowerCase() === String(params[0]).toLowerCase()) return { 1: 1 };
            }
            return null;
        }
        
        if (sql_lower.startsWith("SELECT 1 FROM FRIENDS")) {
            const uid = Number(params[0]); const fid = Number(params[1]);
            return friends.has(`${uid}_${fid}`) ? { 1: 1 } : null;
        }
        
        if (sql_lower.startsWith("SELECT 1 FROM FRIEND_REQUESTS WHERE SENDER_ID")) {
            for (const r of friendRequests.values()) {
                if (Number(r.sender_id) === Number(params[0]) && Number(r.receiver_id) === Number(params[1]) && r.status === "pending") return { id: 1 };
            }
            return null;
        }
        
        if (sql_lower.startsWith("SELECT * FROM FRIEND_REQUESTS WHERE ID")) {
            for (const r of friendRequests.values()) {
                if (r.id === Number(params[0]) && Number(r.receiver_id) === Number(params[1]) && r.status === "pending") return r;
            }
            return null;
        }
        
        if (sql_lower.startsWith("SELECT ID, STATUS FROM FRIEND_REQUESTS WHERE SENDER_ID")) {
            for (const r of friendRequests.values()) {
                if (Number(r.sender_id) === Number(params[0]) && Number(r.receiver_id) === Number(params[1])) return r;
            }
            return null;
        }
        
        if (sql_lower.startsWith("SELECT * FROM USERS WHERE USERNAME")) {
            for (const u of users.values()) {
                if (u.username.toLowerCase() === String(params[0]).toLowerCase()) return u;
            }
            return null;
        }
        
        if (sql_lower.startsWith("SELECT ID, USERNAME, AVATAR FROM USERS WHERE ID")) {
            return users.get(Number(params[0])) || null;
        }
        
        if (sql_lower.startsWith("SELECT USERS.ID")) {
            // getUserByToken
            for (const [token, sess] of sessions) {
                if (token === params[0] && sess.expires_at && new Date(sess.expires_at) > new Date()) {
                    const u = users.get(sess.user_id);
                    if (u) return { id: u.id, username: u.username, avatar: u.avatar, session_hash: token };
                }
            }
            return null;
        }
        
        if (sql_lower.startsWith("SELECT 1 FROM USERS WHERE USERNAME = ? AND ID !=")) {
            for (const u of users.values()) {
                if (u.username.toLowerCase() === String(params[0]).toLowerCase() && u.id !== Number(params[1])) return { 1: 1 };
            }
            return null;
        }
        
        if (sql_lower.startsWith("SELECT ID, SENDER_ID, RECEIVER_ID FROM MESSAGES WHERE ID")) {
            return messages.get(Number(params[0])) || null;
        }
        
        if (sql_lower.startsWith("SELECT FILE_NAME FROM MESSAGES WHERE FILE_URL")) {
            for (const m of messages.values()) {
                if (m.file_url === params[0]) return { file_name: m.file_name };
            }
            return null;
        }
        
        if (sql_lower.startsWith("SELECT 1 FROM MESSAGES WHERE FILE_URL")) {
            for (const m of messages.values()) {
                if (m.file_url === params[0] && (Number(m.sender_id) === Number(params[1]) || Number(m.receiver_id) === Number(params[2]))) return { 1: 1 };
            }
            return null;
        }
        
        return null;
    },
    
    all(sql, params = []) {
        const sql_lower = sql.trim().toUpperCase();
        
        if (sql_lower.startsWith("SELECT FRIEND_ID FROM FRIENDS WHERE USER_ID")) {
            const result = [];
            for (const f of friends.values()) {
                if (Number(f.user_id) === Number(params[0])) result.push({ friend_id: f.friend_id });
            }
            return result;
        }
        
        if (sql_lower.startsWith("SELECT U.ID, U.USERNAME, U.AVATAR")) {
            // Search users or get friends list
            if (sql.includes("FROM FRIENDS F")) {
                // friends list query
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
            // Search users
            const q = String(params[4] || "").replace(/%/g, "").toLowerCase();
            const result = [];
            for (const u of users.values()) {
                if (u.id !== Number(params[3]) && u.username.toLowerCase().includes(q)) {
                    let relation = "none";
                    if (friends.has(`${params[0]}_${u.id}`)) relation = "friend";
                    else {
                        for (const r of friendRequests.values()) {
                            if (Number(r.sender_id) === Number(params[1]) && Number(r.receiver_id) === u.id && r.status === "pending") { relation = "sent"; break; }
                            if (Number(r.sender_id) === u.id && Number(r.receiver_id) === Number(params[2]) && r.status === "pending") { relation = "received"; break; }
                        }
                    }
                    result.push({ id: u.id, username: u.username, avatar: u.avatar, relation });
                }
            }
            result.sort((a, b) => a.username.localeCompare(b.username));
            return result.slice(0, 20);
        }
        
        if (sql_lower.startsWith("SELECT R.ID, U.ID AS USER_ID")) {
            // Friend requests
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
        
        if (sql_lower.startsWith("SELECT * FROM (") || sql_lower.startsWith("SELECT ID, SENDER_ID")) {
            // Messages history
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
    
    saveNow() { /* noop */ }
};

const dbReady = Promise.resolve(db);
console.log("In-memory JS database ready");

module.exports = { db, dbReady };
