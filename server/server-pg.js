"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const multer = require("multer");
const { db, dbReady, pool } = require("./database-pg");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { serveClient: true, maxHttpBufferSize: 100000 });
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const UPLOADS_DIR = process.env.IPK_UPLOADS_DIR || path.join("/tmp", "ipk-uploads");
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const onlineUsers = new Map();

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const ALLOWED_EXTENSIONS = [".doc", ".docx", ".pdf", ".txt", ".rtf", ".xls", ".xlsx", ".ppt", ".pptx", ".zip", ".rar", ".7z", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".mp3", ".mp4", ".wav", ".avi", ".mov"];
const MAX_FILE_SIZE = 50 * 1024 * 1024;

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const today = new Date();
        const monthDir = path.join(UPLOADS_DIR, `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`);
        if (!fs.existsSync(monthDir)) fs.mkdirSync(monthDir, { recursive: true });
        cb(null, monthDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const safeExt = ALLOWED_EXTENSIONS.includes(ext) ? ext : ".bin";
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${safeExt}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ALLOWED_EXTENSIONS.includes(ext)) cb(null, true);
        else cb(null, false);
    }
});

function sendError(res, status, message) {
    return res.status(status).json({ ok: false, error: message, message });
}

function createRateLimiter({ windowMs, max, key }) {
    const buckets = new Map();
    const timer = setInterval(() => {
        const now = Date.now();
        for (const [bucketKey, bucket] of buckets) {
            if (bucket.resetAt <= now) buckets.delete(bucketKey);
        }
    }, Math.min(windowMs, 60000));
    timer.unref();

    return (req, res, next) => {
        const bucketKey = key ? key(req) : req.ip;
        const now = Date.now();
        let bucket = buckets.get(bucketKey);
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            buckets.set(bucketKey, bucket);
        }
        bucket.count += 1;
        if (bucket.count > max) {
            res.setHeader("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
            return sendError(res, 429, "Слишком много запросов. Попробуй немного позже.");
        }
        next();
    };
}

const authLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 30 });
const apiLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 240, key: (req) => `${req.ip}:${req.headers.authorization || "guest"}` });
const messageLimiter = createRateLimiter({ windowMs: 10 * 1000, max: 25, key: (req) => String(req.user?.id || req.ip) });

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    next();
});
app.use(express.json({ limit: "64kb", strict: true }));
app.use("/api", apiLimiter);
app.use(express.static(PUBLIC_DIR, { index: false, dotfiles: "deny", maxAge: 0, etag: false, lastModified: false }));

function hashToken(token) {
    return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

async function issueSession(userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await db.query("DELETE FROM sessions WHERE expires_at <= NOW()");
    await db.query(`DELETE FROM sessions WHERE user_id = $1 AND token NOT IN (SELECT token FROM sessions WHERE user_id = $2 ORDER BY created_at DESC LIMIT 4)`, [userId, userId]);
    await db.query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)", [tokenHash, userId, expiresAt]);
    return token;
}

async function getUserByToken(token) {
    if (!token || typeof token !== "string" || token.length > 256) return null;
    const result = await db.query(`
        SELECT users.id, users.username, users.avatar, sessions.token AS session_hash
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token = $1 AND sessions.expires_at > NOW()
    `, [hashToken(token)]);
    return result.rows[0] || null;
}

function auth(req, res, next) {
    const header = req.headers.authorization || "";
    let token = "";
    if (header.startsWith("Bearer ")) {
        token = header.slice(7).trim();
    } else if (typeof req.query?.token === "string" && req.query.token.length > 0) {
        token = req.query.token.trim();
    }
    if (!token) return sendError(res, 401, "Требуется авторизация");
    getUserByToken(token).then((user) => {
        if (!user) return sendError(res, 401, "Сессия недействительна");
        req.rawToken = token;
        req.sessionHash = user.session_hash;
        req.user = user;
        next();
    }).catch((err) => sendError(res, 500, "Внутренняя ошибка"));
}

function publicUser(user) {
    return { id: Number(user.id), username: user.username, avatar: user.avatar || "" };
}

function normalizeUsername(value) { return String(value || "").trim(); }
function validUsername(username) { return /^[a-zA-Zа-яА-ЯёЁ0-9_]{3,24}$/.test(username); }
function validPassword(password) {
    const value = String(password || "");
    const bytes = Buffer.byteLength(value, "utf8");
    return value.length >= 8 && bytes <= 72;
}
function validLoginPassword(password) {
    const value = String(password || "");
    const bytes = Buffer.byteLength(value, "utf8");
    return value.length > 0 && bytes <= 72;
}

async function isFriend(userId, friendId) {
    const r = await db.query("SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2", [userId, friendId]);
    return r.rows.length > 0;
}

async function getFriendIds(userId) {
    const r = await db.query("SELECT friend_id FROM friends WHERE user_id = $1", [userId]);
    return r.rows.map((row) => Number(row.friend_id));
}

function notifyFriends(userId, event, payload) {
    getFriendIds(userId).then((ids) => ids.forEach((fid) => io.to(`user:${fid}`).emit(event, payload)));
}

// --- Routes ---
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/api/status", (req, res) => res.json({ ok: true, server: "ИПК", time: new Date().toISOString() }));

app.post("/api/register", authLimiter, async (req, res) => {
    try {
        const username = normalizeUsername(req.body?.username);
        const password = String(req.body?.password || "");
        if (!validUsername(username)) return sendError(res, 400, "Никнейм: 3–24 символа, только буквы, цифры и _");
        if (!validPassword(password)) return sendError(res, 400, "Пароль должен содержать минимум 8 символов и не превышать 72 байта");
        const exists = await db.query("SELECT 1 FROM users WHERE username = $1", [username]);
        if (exists.rows.length) return sendError(res, 409, "Такой никнейм уже занят");
        const passwordHash = await bcrypt.hash(password, 12);
        const ins = await db.query("INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id, username, avatar", [username, passwordHash]);
        const user = ins.rows[0];
        const token = await issueSession(user.id);
        return res.status(201).json({ ok: true, token, user: publicUser(user) });
    } catch (error) {
        console.error("REGISTER ERROR:", error);
        return sendError(res, 500, "Не удалось создать аккаунт");
    }
});

app.post("/api/login", authLimiter, async (req, res) => {
    try {
        const username = normalizeUsername(req.body?.username);
        const password = String(req.body?.password || "");
        if (!validUsername(username) || !validLoginPassword(password)) return sendError(res, 401, "Неверный никнейм или пароль");
        const result = await db.query("SELECT * FROM users WHERE username = $1", [username]);
        const user = result.rows[0];
        const valid = user ? await bcrypt.compare(password, user.password) : false;
        if (!valid) return sendError(res, 401, "Неверный никнейм или пароль");
        const token = await issueSession(user.id);
        return res.json({ ok: true, token, user: publicUser(user) });
    } catch (error) {
        console.error("LOGIN ERROR:", error);
        return sendError(res, 500, "Не удалось войти");
    }
});

app.get("/api/me", auth, (req, res) => res.json({ ok: true, user: publicUser(req.user) }));

app.post("/api/logout", auth, async (req, res) => {
    await db.query("DELETE FROM sessions WHERE token = $1", [req.sessionHash]);
    const sockets = await io.in(`user:${req.user.id}`).fetchSockets();
    sockets.filter((s) => s.sessionHash === req.sessionHash).forEach((s) => s.disconnect(true));
    res.json({ ok: true });
});

app.put("/api/profile", auth, async (req, res) => {
    try {
        const username = normalizeUsername(req.body?.username);
        if (!validUsername(username)) return sendError(res, 400, "Никнейм: 3–24 символа, только буквы, цифры и _");
        const existing = await db.query("SELECT 1 FROM users WHERE username = $1 AND id != $2", [username, req.user.id]);
        if (existing.rows.length) return sendError(res, 409, "Такой никнейм уже занят");
        await db.query("UPDATE users SET username = $1 WHERE id = $2", [username, req.user.id]);
        const result = await db.query("SELECT id, username, avatar FROM users WHERE id = $1", [req.user.id]);
        const user = result.rows[0];
        notifyFriends(req.user.id, "friend:profile", publicUser(user));
        return res.json({ ok: true, user: publicUser(user) });
    } catch (error) {
        console.error("PROFILE ERROR:", error);
        return sendError(res, 500, "Не удалось сохранить профиль");
    }
});

app.get("/api/users/search", auth, async (req, res) => {
    const q = normalizeUsername(req.query.q).slice(0, 24);
    if (q.length < 2) return res.json({ ok: true, users: [] });
    const result = await db.query(`
        SELECT u.id, u.username, u.avatar,
            CASE
                WHEN EXISTS (SELECT 1 FROM friends f WHERE f.user_id = $1 AND f.friend_id = u.id) THEN 'friend'
                WHEN EXISTS (SELECT 1 FROM friend_requests r WHERE r.sender_id = $2 AND r.receiver_id = u.id AND r.status = 'pending') THEN 'sent'
                WHEN EXISTS (SELECT 1 FROM friend_requests r WHERE r.sender_id = u.id AND r.receiver_id = $3 AND r.status = 'pending') THEN 'received'
                ELSE 'none'
            END AS relation
        FROM users u
        WHERE u.id != $4 AND u.username ILIKE $5
        ORDER BY CASE WHEN u.username = $6 THEN 0 ELSE 1 END, u.username
        LIMIT 20
    `, [req.user.id, req.user.id, req.user.id, req.user.id, `%${q.replace(/[%_]/g, "\\$&")}%`, q]);
    res.json({ ok: true, users: result.rows.map((u) => ({ ...publicUser(u), relation: u.relation })) });
});

app.get("/api/friends", auth, async (req, res) => {
    const result = await db.query(`
        SELECT u.id, u.username, u.avatar, u.last_seen,
            (SELECT m.text FROM messages m
             WHERE (m.sender_id = f.user_id AND m.receiver_id = u.id)
                OR (m.sender_id = u.id AND m.receiver_id = f.user_id)
             ORDER BY m.id DESC LIMIT 1) AS last_message,
            (SELECT m.created_at FROM messages m
             WHERE (m.sender_id = f.user_id AND m.receiver_id = u.id)
                OR (m.sender_id = u.id AND m.receiver_id = f.user_id)
             ORDER BY m.id DESC LIMIT 1) AS last_message_at,
            (SELECT COUNT(*) FROM messages m
             WHERE m.sender_id = u.id AND m.receiver_id = f.user_id AND m.is_read = 0) AS unread_count
        FROM friends f
        JOIN users u ON u.id = f.friend_id
        WHERE f.user_id = $1
        ORDER BY COALESCE(last_message_at, f.created_at) DESC, u.username
    `, [req.user.id]);
    res.json({ ok: true, friends: result.rows.map((f) => ({ ...publicUser(f), last_message: f.last_message || "", last_message_at: f.last_message_at || "", unread_count: Number(f.unread_count) || 0, last_seen: f.last_seen || "" })) });
});

app.post("/api/friends/request", auth, async (req, res) => {
    try {
        const targetId = Number(req.body?.userId);
        if (!Number.isSafeInteger(targetId) || targetId <= 0) return sendError(res, 400, "Некорректный пользователь");
        if (targetId === req.user.id) return sendError(res, 400, "Нельзя добавить самого себя");
        const target = await db.query("SELECT id, username, avatar FROM users WHERE id = $1", [targetId]);
        if (!target.rows.length) return sendError(res, 404, "Пользователь не найден");
        if (await isFriend(req.user.id, targetId)) return sendError(res, 409, "Вы уже друзья");
        const reverse = await db.query("SELECT id FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2 AND status = 'pending'", [targetId, req.user.id]);
        if (reverse.rows.length) return sendError(res, 409, "Этот пользователь уже отправил тебе заявку");
        const existing = await db.query("SELECT id, status FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2", [req.user.id, targetId]);
        if (existing.rows[0]?.status === "pending") return sendError(res, 409, "Заявка уже отправлена");
        if (existing.rows.length) await db.query("UPDATE friend_requests SET status = 'pending', created_at = NOW() WHERE id = $1", [existing.rows[0].id]);
        else await db.query("INSERT INTO friend_requests (sender_id, receiver_id, status) VALUES ($1, $2, 'pending')", [req.user.id, targetId]);
        io.to(`user:${targetId}`).emit("friend:request", publicUser(req.user));
        res.status(201).json({ ok: true, message: "Заявка отправлена" });
    } catch (e) { sendError(res, 500, "Ошибка"); }
});

app.get("/api/friends/requests", auth, async (req, res) => {
    const result = await db.query(`
        SELECT r.id, u.id AS user_id, u.username, u.avatar, r.created_at
        FROM friend_requests r JOIN users u ON u.id = r.sender_id
        WHERE r.receiver_id = $1 AND r.status = 'pending'
        ORDER BY r.created_at DESC
    `, [req.user.id]);
    res.json({ ok: true, requests: result.rows });
});

app.post("/api/friends/accept", auth, async (req, res) => {
    const requestId = Number(req.body?.requestId);
    if (!Number.isSafeInteger(requestId)) return sendError(res, 400, "Некорректная заявка");
    const result = await db.query("SELECT * FROM friend_requests WHERE id = $1 AND receiver_id = $2 AND status = 'pending'", [requestId, req.user.id]);
    if (!result.rows.length) return sendError(res, 404, "Заявка не найдена");
    const request = result.rows[0];
    await db.query("UPDATE friend_requests SET status = 'accepted' WHERE id = $1", [request.id]);
    await db.query("INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [request.sender_id, request.receiver_id]);
    await db.query("INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [request.receiver_id, request.sender_id]);
    io.to(`user:${request.sender_id}`).emit("friend:accepted", publicUser(req.user));
    res.json({ ok: true });
});

app.post("/api/friends/reject", auth, async (req, res) => {
    const requestId = Number(req.body?.requestId);
    if (!Number.isSafeInteger(requestId)) return sendError(res, 400, "Некорректная заявка");
    const result = await db.query("UPDATE friend_requests SET status = 'rejected' WHERE id = $1 AND receiver_id = $2 AND status = 'pending'", [requestId, req.user.id]);
    if (!result.rowCount) return sendError(res, 404, "Заявка не найдена");
    res.json({ ok: true });
});

app.delete("/api/friends/:userId", auth, async (req, res) => {
    const friendId = Number(req.params.userId);
    if (!Number.isSafeInteger(friendId) || friendId <= 0) return sendError(res, 400, "Некорректный пользователь");
    await db.query("DELETE FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $3 AND friend_id = $4)", [req.user.id, friendId, friendId, req.user.id]);
    await db.query("DELETE FROM friend_requests WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $3 AND receiver_id = $4)", [req.user.id, friendId, friendId, req.user.id]);
    io.to(`user:${friendId}`).emit("friend:removed", { userId: req.user.id });
    res.json({ ok: true });
});

app.get("/api/messages/:userId", auth, async (req, res) => {
    const otherId = Number(req.params.userId);
    const before = req.query.before ? Number(req.query.before) : null;
    if (!Number.isSafeInteger(otherId) || otherId <= 0) return sendError(res, 400, "Некорректный пользователь");
    if (!(await isFriend(req.user.id, otherId))) return sendError(res, 403, "Переписка доступна только друзьям");
    const params = [req.user.id, otherId, otherId, req.user.id];
    let query = `
        SELECT * FROM (
            SELECT id, sender_id, receiver_id, text, message_type, file_name, file_url, file_size, is_read, created_at
            FROM messages
            WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $3 AND receiver_id = $4))
    `;
    if (before !== null && Number.isSafeInteger(before) && before > 0) {
        query += ` AND id < $5`;
        params.push(before);
    }
    query += ` ORDER BY id DESC LIMIT 100) ORDER BY id ASC`;
    const result = await db.query(query, params);
    res.json({ ok: true, messages: result.rows, hasMore: result.rows.length === 100 });
});

app.post("/api/messages", auth, messageLimiter, async (req, res) => {
    const receiverId = Number(req.body?.receiverId);
    const text = String(req.body?.text || "").trim();
    if (!Number.isSafeInteger(receiverId) || receiverId <= 0) return sendError(res, 400, "Некорректный получатель");
    if (!text) return sendError(res, 400, "Сообщение пустое");
    if (text.length > 5000) return sendError(res, 400, "Сообщение слишком длинное");
    if (!(await isFriend(req.user.id, receiverId))) return sendError(res, 403, "Писать можно только друзьям");
    const ins = await db.query("INSERT INTO messages (sender_id, receiver_id, text, message_type) VALUES ($1, $2, $3, 'text') RETURNING id, sender_id, receiver_id, text, message_type, file_name, file_url, file_size, is_read, created_at", [req.user.id, receiverId, text]);
    const message = ins.rows[0];
    io.to(`user:${receiverId}`).emit("message:new", message);
    io.to(`user:${req.user.id}`).emit("message:sent", message);
    res.status(201).json({ ok: true, message });
});

app.post("/api/messages/:userId/read", auth, async (req, res) => {
    const senderId = Number(req.params.userId);
    if (!Number.isSafeInteger(senderId) || senderId <= 0) return sendError(res, 400, "Некорректный пользователь");
    if (!(await isFriend(req.user.id, senderId))) return sendError(res, 403, "Недоступно");
    const result = await db.query("UPDATE messages SET is_read = 1 WHERE sender_id = $1 AND receiver_id = $2 AND is_read = 0", [senderId, req.user.id]);
    if (result.rowCount) io.to(`user:${senderId}`).emit("messages:read", { userId: req.user.id });
    res.json({ ok: true, updated: result.rowCount });
});

app.delete("/api/messages/:messageId", auth, async (req, res) => {
    const messageId = Number(req.params.messageId);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return sendError(res, 400, "Некорректное сообщение");
    const result = await db.query("SELECT id, sender_id, receiver_id FROM messages WHERE id = $1", [messageId]);
    if (!result.rows.length) return sendError(res, 404, "Сообщение не найдено");
    const message = result.rows[0];
    if (Number(message.sender_id) !== Number(req.user.id)) return sendError(res, 403, "Можно удалять только свои сообщения");
    await db.query("DELETE FROM messages WHERE id = $1", [messageId]);
    io.to(`user:${message.receiver_id}`).emit("message:deleted", { id: messageId });
    io.to(`user:${req.user.id}`).emit("message:deleted", { id: messageId });
    res.json({ ok: true });
});

app.post("/api/upload", auth, messageLimiter, upload.single("file"), async (req, res) => {
    try {
        if (!req.file) return sendError(res, 400, "Файл не загружен.");
        const receiverId = Number(req.body?.receiverId);
        if (!Number.isSafeInteger(receiverId) || receiverId <= 0) return sendError(res, 400, "Некорректный получатель");
        if (!(await isFriend(req.user.id, receiverId))) return sendError(res, 403, "Отправлять файлы можно только друзьям");
        const fileName = String(req.file.originalname || "file").slice(0, 200).replace(/[^\p{L}\p{N}.\-_\s()]/gu, "").trim() || "file";
        const fileUrl = `/api/files/${path.basename(req.file.path)}`;
        const fileSize = req.file.size;
        const ins = await db.query("INSERT INTO messages (sender_id, receiver_id, text, message_type, file_name, file_url, file_size) VALUES ($1, $2, '', 'file', $3, $4, $5) RETURNING id, sender_id, receiver_id, text, message_type, file_name, file_url, file_size, is_read, created_at", [req.user.id, receiverId, fileName, fileUrl, fileSize]);
        const message = ins.rows[0];
        io.to(`user:${receiverId}`).emit("message:new", message);
        io.to(`user:${req.user.id}`).emit("message:sent", message);
        res.status(201).json({ ok: true, message });
    } catch (error) {
        console.error("UPLOAD ERROR:", error);
        return sendError(res, 500, "Не удалось загрузить файл");
    }
});

app.get("/api/files/:filename", auth, async (req, res) => {
    const filename = path.basename(String(req.params.filename));
    if (!/^[\w.\-]+$/.test(filename)) return sendError(res, 400, "Некорректное имя файла");
    const months = fs.readdirSync(UPLOADS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
    let filePath = null;
    for (const month of months) {
        const candidate = path.join(UPLOADS_DIR, month, filename);
        if (fs.existsSync(candidate)) { filePath = candidate; break; }
    }
    if (!filePath) return sendError(res, 404, "Файл не найден");
    const fileUrl = `/api/files/${filename}`;
    const record = await db.query("SELECT 1 FROM messages WHERE file_url = $1 AND (sender_id = $2 OR receiver_id = $3) LIMIT 1", [fileUrl, req.user.id, req.user.id]);
    if (!record.rows.length) return sendError(res, 403, "Доступ запрещён");
    const msg = await db.query("SELECT file_name FROM messages WHERE file_url = $1 LIMIT 1", [fileUrl]);
    const downloadName = msg.rows[0]?.file_name || filename;
    res.setHeader("Content-Disposition", `attachment; filename="=?UTF-8?B?${Buffer.from(downloadName).toString("base64")}?="`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(filePath);
});

// --- Socket.IO ---
io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth?.token;
        const user = await getUserByToken(token);
        if (!user) return next(new Error("Сессия недействительна"));
        socket.user = user;
        socket.sessionHash = user.session_hash;
        next();
    } catch (error) { next(error); }
});

io.on("connection", (socket) => {
    const userId = Number(socket.user.id);
    socket.join(`user:${userId}`);
    const firstConnection = !onlineUsers.has(userId);
    if (firstConnection) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);
    if (firstConnection) {
        db.query("UPDATE users SET last_seen = NOW() WHERE id = $1", [userId]).catch(() => {});
        notifyFriends(userId, "user:online", { userId });
    }

    const sendPresence = async () => {
        const ids = await getFriendIds(userId);
        const onlineIds = ids.filter((fid) => onlineUsers.has(fid));
        socket.emit("presence:snapshot", { userIds: onlineIds });
    };
    sendPresence();
    socket.on("presence:get", () => sendPresence());

    let lastTypingAt = 0;
    const relayTyping = async (event, payload) => {
        const receiverId = Number(payload?.receiverId);
        if (!Number.isSafeInteger(receiverId) || !(await isFriend(userId, receiverId))) return;
        const now = Date.now();
        if (event === "typing:start" && now - lastTypingAt < 250) return;
        lastTypingAt = now;
        socket.to(`user:${receiverId}`).emit(event, { userId, username: socket.user.username });
    };
    socket.on("typing:start", (p) => relayTyping("typing:start", p));
    socket.on("typing:stop", (p) => relayTyping("typing:stop", p));

    socket.on("disconnect", () => {
        const sockets = onlineUsers.get(userId);
        if (!sockets) return;
        sockets.delete(socket.id);
        if (!sockets.size) {
            onlineUsers.delete(userId);
            const lastSeen = new Date().toISOString();
            db.query("UPDATE users SET last_seen = NOW() WHERE id = $1", [userId]).catch(() => {});
            notifyFriends(userId, "user:offline", { userId, last_seen: lastSeen });
        }
    });
});

app.use((req, res) => {
    if (req.path.startsWith("/api/")) return sendError(res, 404, "Маршрут не найден");
    res.status(404).sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use((error, req, res, next) => {
    if (error instanceof SyntaxError && "body" in error) return sendError(res, 400, "Некорректный JSON");
    console.error("UNHANDLED ERROR:", error);
    return sendError(res, 500, "Внутренняя ошибка сервера");
});

// Wait for DB to be ready before starting
dbReady.then(() => {
    server.listen(PORT, HOST, () => {
        console.log(`ИПК запущен: http://${HOST}:${PORT}`);
    });
}).catch((err) => {
    console.error("DB INIT FAILED:", err);
    process.exit(1);
});

function shutdown() {
    io.close();
    server.close(() => {
        pool.end();
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
