"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const multer = require("multer");
const { db, dbReady } = require("./database-sqlite");

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

function issueSession(userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    db.run("DELETE FROM sessions WHERE expires_at <= ?", [new Date().toISOString()]);
    db.run("DELETE FROM sessions WHERE user_id = ? AND token NOT IN (SELECT token FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 4)", [userId, userId]);
    db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", [tokenHash, userId, expiresAt]);
    return token;
}

function getUserByToken(token) {
    if (!token || typeof token !== "string" || token.length > 256) return null;
    return db.get("SELECT users.id, users.username, users.avatar, sessions.token AS session_hash FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ? AND sessions.expires_at > ?", [hashToken(token), new Date().toISOString()]) || null;
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
    const user = getUserByToken(token);
    if (!user) return sendError(res, 401, "Сессия недействительна");
    req.rawToken = token;
    req.sessionHash = user.session_hash;
    req.user = user;
    next();
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

function isFriend(userId, friendId) {
    return Boolean(db.get("SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?", [userId, friendId]));
}

function getFriendIds(userId) {
    return db.all("SELECT friend_id FROM friends WHERE user_id = ?", [userId]).map((row) => Number(row.friend_id));
}

function notifyFriends(userId, event, payload) {
    getFriendIds(userId).forEach((friendId) => io.to(`user:${friendId}`).emit(event, payload));
}

app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/api/status", (req, res) => res.json({ ok: true, server: "ИПК", version: "2.1.1", db: "in-memory-js", time: new Date().toISOString() }));
app.get("/api/health", (req, res) => res.json({ ok: true, status: "healthy", db: "in-memory-js", uptime: process.uptime() }));

app.post("/api/register", authLimiter, async (req, res) => {
    try {
        const username = normalizeUsername(req.body?.username);
        const password = String(req.body?.password || "");
        if (!validUsername(username)) return sendError(res, 400, "Никнейм: 3–24 символа, только буквы, цифры и _");
        if (!validPassword(password)) return sendError(res, 400, "Пароль должен содержать минимум 8 символов и не превышать 72 байта");
        if (db.get("SELECT 1 FROM users WHERE username = ?", [username])) return sendError(res, 409, "Такой никнейм уже занят");
        const passwordHash = await bcrypt.hash(password, 12);
        const result = db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, passwordHash]);
        const user = db.get("SELECT id, username, avatar FROM users WHERE id = ?", [result.lastInsertRowid]);
        const token = issueSession(user.id);
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
        const user = db.get("SELECT * FROM users WHERE username = ?", [username]);
        const valid = user ? await bcrypt.compare(password, user.password) : false;
        if (!valid) return sendError(res, 401, "Неверный никнейм или пароль");
        const token = issueSession(user.id);
        return res.json({ ok: true, token, user: publicUser(user) });
    } catch (error) {
        console.error("LOGIN ERROR:", error);
        return sendError(res, 500, "Не удалось войти");
    }
});

app.get("/api/me", auth, (req, res) => res.json({ ok: true, user: publicUser(req.user) }));

app.post("/api/logout", auth, async (req, res) => {
    db.run("DELETE FROM sessions WHERE token = ?", [req.sessionHash]);
    const sockets = await io.in(`user:${req.user.id}`).fetchSockets();
    sockets.filter((socket) => socket.sessionHash === req.sessionHash).forEach((socket) => socket.disconnect(true));
    res.json({ ok: true });
});

app.put("/api/profile", auth, (req, res) => {
    try {
        const username = normalizeUsername(req.body?.username);
        if (!validUsername(username)) return sendError(res, 400, "Никнейм: 3–24 символа, только буквы, цифры и _");
        const existing = db.get("SELECT 1 FROM users WHERE username = ? AND id != ?", [username, req.user.id]);
        if (existing) return sendError(res, 409, "Такой никнейм уже занят");
        db.run("UPDATE users SET username = ? WHERE id = ?", [username, req.user.id]);
        const user = db.get("SELECT id, username, avatar FROM users WHERE id = ?", [req.user.id]);
        notifyFriends(req.user.id, "friend:profile", publicUser(user));
        return res.json({ ok: true, user: publicUser(user) });
    } catch (error) {
        console.error("PROFILE ERROR:", error);
        return sendError(res, 500, "Не удалось сохранить профиль");
    }
});

app.get("/api/users/search", auth, (req, res) => {
    const q = normalizeUsername(req.query.q).slice(0, 24);
    if (q.length < 2) return res.json({ ok: true, users: [] });
    const users = db.all(`
        SELECT u.id, u.username, u.avatar,
            CASE
                WHEN EXISTS (SELECT 1 FROM friends f WHERE f.user_id = ? AND f.friend_id = u.id) THEN 'friend'
                WHEN EXISTS (SELECT 1 FROM friend_requests r WHERE r.sender_id = ? AND r.receiver_id = u.id AND r.status = 'pending') THEN 'sent'
                WHEN EXISTS (SELECT 1 FROM friend_requests r WHERE r.sender_id = u.id AND r.receiver_id = ? AND r.status = 'pending') THEN 'received'
                ELSE 'none'
            END AS relation
        FROM users u
        WHERE u.id != ? AND u.username LIKE ? ESCAPE '\\'
        ORDER BY CASE WHEN u.username = ? COLLATE NOCASE THEN 0 ELSE 1 END, u.username COLLATE NOCASE
        LIMIT 20
    `, [req.user.id, req.user.id, req.user.id, req.user.id, `%${q.replace(/[\\%_]/g, "\\$&")}%`, q]);
    res.json({ ok: true, users: users.map((user) => ({ ...publicUser(user), relation: user.relation })) });
});

app.get("/api/friends", auth, (req, res) => {
    const friends = db.all(`
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
        WHERE f.user_id = ?
        ORDER BY COALESCE(last_message_at, f.created_at) DESC, u.username COLLATE NOCASE
    `, [req.user.id]);
    res.json({ ok: true, friends: friends.map((friend) => ({ ...publicUser(friend), last_message: friend.last_message || "", last_message_at: friend.last_message_at || "", unread_count: Number(friend.unread_count) || 0, last_seen: friend.last_seen || "" })) });
});

app.post("/api/friends/request", auth, (req, res) => {
    const targetId = Number(req.body?.userId);
    if (!Number.isSafeInteger(targetId) || targetId <= 0) return sendError(res, 400, "Некорректный пользователь");
    if (targetId === req.user.id) return sendError(res, 400, "Нельзя добавить самого себя");
    const target = db.get("SELECT id, username, avatar FROM users WHERE id = ?", [targetId]);
    if (!target) return sendError(res, 404, "Пользователь не найден");
    if (isFriend(req.user.id, targetId)) return sendError(res, 409, "Вы уже друзья");
    const reverse = db.get("SELECT id FROM friend_requests WHERE sender_id = ? AND receiver_id = ? AND status = 'pending'", [targetId, req.user.id]);
    if (reverse) return sendError(res, 409, "Этот пользователь уже отправил тебе заявку");
    const existing = db.get("SELECT id, status FROM friend_requests WHERE sender_id = ? AND receiver_id = ?", [req.user.id, targetId]);
    if (existing?.status === "pending") return sendError(res, 409, "Заявка уже отправлена");
    if (existing) db.run("UPDATE friend_requests SET status = 'pending', created_at = datetime('now') WHERE id = ?", [existing.id]);
    else db.run("INSERT INTO friend_requests (sender_id, receiver_id, status) VALUES (?, ?, 'pending')", [req.user.id, targetId]);
    io.to(`user:${targetId}`).emit("friend:request", publicUser(req.user));
    res.status(201).json({ ok: true, message: "Заявка отправлена" });
});

app.get("/api/friends/requests", auth, (req, res) => {
    const requests = db.all(`
        SELECT r.id, u.id AS user_id, u.username, u.avatar, r.created_at
        FROM friend_requests r JOIN users u ON u.id = r.sender_id
        WHERE r.receiver_id = ? AND r.status = 'pending'
        ORDER BY r.created_at DESC
    `, [req.user.id]);
    res.json({ ok: true, requests });
});

app.post("/api/friends/accept", auth, (req, res) => {
    const requestId = Number(req.body?.requestId);
    if (!Number.isSafeInteger(requestId)) return sendError(res, 400, "Некорректная заявка");
    const request = db.get("SELECT * FROM friend_requests WHERE id = ? AND receiver_id = ? AND status = 'pending'", [requestId, req.user.id]);
    if (!request) return sendError(res, 404, "Заявка не найдена");
    db.run("UPDATE friend_requests SET status = 'accepted' WHERE id = ?", [request.id]);
    db.run("INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)", [request.sender_id, request.receiver_id]);
    db.run("INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)", [request.receiver_id, request.sender_id]);
    io.to(`user:${request.sender_id}`).emit("friend:accepted", publicUser(req.user));
    res.json({ ok: true });
});

app.post("/api/friends/reject", auth, (req, res) => {
    const requestId = Number(req.body?.requestId);
    if (!Number.isSafeInteger(requestId)) return sendError(res, 400, "Некорректная заявка");
    const result = db.run("UPDATE friend_requests SET status = 'rejected' WHERE id = ? AND receiver_id = ? AND status = 'pending'", [requestId, req.user.id]);
    if (!result.changes) return sendError(res, 404, "Заявка не найдена");
    res.json({ ok: true });
});

app.delete("/api/friends/:userId", auth, (req, res) => {
    const friendId = Number(req.params.userId);
    if (!Number.isSafeInteger(friendId) || friendId <= 0) return sendError(res, 400, "Некорректный пользователь");
    db.run("DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)", [req.user.id, friendId, friendId, req.user.id]);
    db.run("DELETE FROM friend_requests WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)", [req.user.id, friendId, friendId, req.user.id]);
    io.to(`user:${friendId}`).emit("friend:removed", { userId: req.user.id });
    res.json({ ok: true });
});

app.get("/api/messages/:userId", auth, (req, res) => {
    const otherId = Number(req.params.userId);
    const before = req.query.before ? Number(req.query.before) : null;
    if (!Number.isSafeInteger(otherId) || otherId <= 0) return sendError(res, 400, "Некорректный пользователь");
    if (!isFriend(req.user.id, otherId)) return sendError(res, 403, "Переписка доступна только друзьям");
    if (before !== null && (!Number.isSafeInteger(before) || before <= 0)) return sendError(res, 400, "Некорректный курсор");
    const history = db.all(`
        SELECT * FROM (
            SELECT id, sender_id, receiver_id, text, message_type, file_name, file_url, file_size, is_read, created_at
            FROM messages
            WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
              AND (? IS NULL OR id < ?)
            ORDER BY id DESC LIMIT 100
        ) ORDER BY id ASC
    `, [req.user.id, otherId, otherId, req.user.id, before, before]);
    res.json({ ok: true, messages: history, hasMore: history.length === 100 });
});

app.post("/api/messages", auth, messageLimiter, (req, res) => {
    const receiverId = Number(req.body?.receiverId);
    const text = String(req.body?.text || "").trim();
    if (!Number.isSafeInteger(receiverId) || receiverId <= 0) return sendError(res, 400, "Некорректный получатель");
    if (!text) return sendError(res, 400, "Сообщение пустое");
    if (text.length > 5000) return sendError(res, 400, "Сообщение слишком длинное");
    if (!isFriend(req.user.id, receiverId)) return sendError(res, 403, "Писать можно только друзьям");
    const result = db.run("INSERT INTO messages (sender_id, receiver_id, text, message_type) VALUES (?, ?, ?, 'text')", [req.user.id, receiverId, text]);
    const message = db.get("SELECT id, sender_id, receiver_id, text, message_type, file_name, file_url, file_size, is_read, created_at FROM messages WHERE id = ?", [result.lastInsertRowid]);
    io.to(`user:${receiverId}`).emit("message:new", message);
    io.to(`user:${req.user.id}`).emit("message:sent", message);
    res.status(201).json({ ok: true, message });
});

app.post("/api/messages/:userId/read", auth, (req, res) => {
    const senderId = Number(req.params.userId);
    if (!Number.isSafeInteger(senderId) || senderId <= 0) return sendError(res, 400, "Некорректный пользователь");
    if (!isFriend(req.user.id, senderId)) return sendError(res, 403, "Недоступно");
    const result = db.run("UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0", [senderId, req.user.id]);
    if (result.changes) io.to(`user:${senderId}`).emit("messages:read", { userId: req.user.id });
    res.json({ ok: true, updated: result.changes });
});

app.delete("/api/messages/:messageId", auth, (req, res) => {
    const messageId = Number(req.params.messageId);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return sendError(res, 400, "Некорректное сообщение");
    const message = db.get("SELECT id, sender_id, receiver_id FROM messages WHERE id = ?", [messageId]);
    if (!message) return sendError(res, 404, "Сообщение не найдено");
    if (Number(message.sender_id) !== Number(req.user.id)) return sendError(res, 403, "Можно удалять только свои сообщения");
    db.run("DELETE FROM messages WHERE id = ?", [messageId]);
    io.to(`user:${message.receiver_id}`).emit("message:deleted", { id: messageId });
    io.to(`user:${req.user.id}`).emit("message:deleted", { id: messageId });
    res.json({ ok: true });
});

app.post("/api/upload", auth, messageLimiter, upload.single("file"), (req, res) => {
    try {
        if (!req.file) return sendError(res, 400, "Файл не загружен.");
        const receiverId = Number(req.body?.receiverId);
        if (!Number.isSafeInteger(receiverId) || receiverId <= 0) return sendError(res, 400, "Некорректный получатель");
        if (!isFriend(req.user.id, receiverId)) return sendError(res, 403, "Отправлять файлы можно только друзьям");
        const fileName = String(req.file.originalname || "file").slice(0, 200).replace(/[^\p{L}\p{N}.\-_\s()]/gu, "").trim() || "file";
        const fileUrl = `/api/files/${path.basename(req.file.path)}`;
        const fileSize = req.file.size;
        const result = db.run("INSERT INTO messages (sender_id, receiver_id, text, message_type, file_name, file_url, file_size) VALUES (?, ?, '', 'file', ?, ?, ?)", [req.user.id, receiverId, fileName, fileUrl, fileSize]);
        const message = db.get("SELECT id, sender_id, receiver_id, text, message_type, file_name, file_url, file_size, is_read, created_at FROM messages WHERE id = ?", [result.lastInsertRowid]);
        io.to(`user:${receiverId}`).emit("message:new", message);
        io.to(`user:${req.user.id}`).emit("message:sent", message);
        res.status(201).json({ ok: true, message });
    } catch (error) {
        console.error("UPLOAD ERROR:", error);
        return sendError(res, 500, "Не удалось загрузить файл");
    }
});

app.get("/api/files/:filename", auth, (req, res) => {
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
    const record = db.get("SELECT 1 FROM messages WHERE file_url = ? AND (sender_id = ? OR receiver_id = ?) LIMIT 1", [fileUrl, req.user.id, req.user.id]);
    if (!record) return sendError(res, 403, "Доступ запрещён");
    const msg = db.get("SELECT file_name FROM messages WHERE file_url = ? LIMIT 1", [fileUrl]);
    const downloadName = msg?.file_name || filename;
    res.setHeader("Content-Disposition", `attachment; filename="=?UTF-8?B?${Buffer.from(downloadName).toString("base64")}?="`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(filePath);
});

io.use((socket, next) => {
    try {
        const token = socket.handshake.auth?.token;
        const user = getUserByToken(token);
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
        db.run("UPDATE users SET last_seen = ? WHERE id = ?", [new Date().toISOString(), userId]);
        notifyFriends(userId, "user:online", { userId });
    }

    const sendPresence = () => {
        const onlineFriendIds = getFriendIds(userId).filter((friendId) => onlineUsers.has(friendId));
        socket.emit("presence:snapshot", { userIds: onlineFriendIds });
    };
    sendPresence();
    socket.on("presence:get", sendPresence);

    let lastTypingAt = 0;
    const relayTyping = (event, payload) => {
        const receiverId = Number(payload?.receiverId);
        if (!Number.isSafeInteger(receiverId) || !isFriend(userId, receiverId)) return;
        const now = Date.now();
        if (event === "typing:start" && now - lastTypingAt < 250) return;
        lastTypingAt = now;
        socket.to(`user:${receiverId}`).emit(event, { userId, username: socket.user.username });
    };
    socket.on("typing:start", (payload) => relayTyping("typing:start", payload));
    socket.on("typing:stop", (payload) => relayTyping("typing:stop", payload));

    socket.on("disconnect", () => {
        const sockets = onlineUsers.get(userId);
        if (!sockets) return;
        sockets.delete(socket.id);
        if (!sockets.size) {
            onlineUsers.delete(userId);
            const lastSeen = new Date().toISOString();
            db.run("UPDATE users SET last_seen = ? WHERE id = ?", [lastSeen, userId]);
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

dbReady.then(() => {
    server.listen(PORT, HOST, () => {
        console.log(`ИПК запущен: http://${HOST}:${PORT}`);
    });
}).catch((err) => {
    console.error("DB INIT FAILED:", err);
    process.exit(1);
});

function shutdown() {
    db.saveNow();
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
