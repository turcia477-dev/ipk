"use strict";

/**
 * ИПК — сервер. v2.3.0
 *
 * Работает через постоянный слой данных (database-sqlite.js): обычные функции
 * вместо SQL-строк. Файлы сохраняются в постоянный каталог рядом с базой,
 * а не в /tmp, который стирается при перезапуске контейнера.
 *
 * Принимаются файлы ЛЮБЫХ типов, включая картинки и скриншоты.
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const multer = require("multer");
const db = require("./database-sqlite");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { serveClient: true, maxHttpBufferSize: 200000 });
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const UPLOADS_DIR = process.env.IPK_UPLOADS_DIR || path.join(db.DATA_DIR, "uploads");
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// 256 МБ хранилища на бесплатном тарифе Bonto — 25 МБ на файл это разумный потолок.
const MAX_FILE_SIZE = Number(process.env.IPK_MAX_FILE_SIZE) || 25 * 1024 * 1024;

// Эти расширения показываем прямо в переписке картинкой. Всё остальное — скачиванием.
const INLINE_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];

const onlineUsers = new Map();

// Каталог вложений создаём ЛЕНИВО — только когда реально понадобится.
// При старте нельзя трогать файловую систему: на Bonto приложение работает
// под nodemon, и любое создание или удаление файла вызывает перезапуск.
let uploadsReady = null;

function ensureUploadsDir() {
    if (uploadsReady !== null) return uploadsReady;
    try {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        uploadsReady = true;
    } catch (error) {
        console.error(`НЕ УДАЛОСЬ создать каталог вложений ${UPLOADS_DIR}: ${error.code || error.message}`);
        console.error("Загрузка файлов будет недоступна, остальное работает.");
        uploadsReady = false;
    }
    return uploadsReady;
}

/* ---------- Приём файлов ---------- */

/**
 * Браузер отправляет имя файла в UTF-8, а multipart-парсер (busboy 1.x внутри
 * multer 2.x) читает эти байты как latin1. Из-за этого «скриншот.png»
 * превращается в «ÑÐºÑÐ¸Ð½ÑÐ¾Ñ.png». Перекодируем обратно.
 * Если после перекодировки получились символы-заглушки — значит имя и не было
 * UTF-8, тогда оставляем как есть.
 */
function decodeMultipartName(name) {
    const raw = String(name || "");
    if (!/[\u0080-\u00ff]/.test(raw)) return raw;
    const decoded = Buffer.from(raw, "latin1").toString("utf8");
    return decoded.includes("\uFFFD") ? raw : decoded;
}

function safeExtension(originalName) {
    const ext = path.extname(decodeMultipartName(originalName)).toLowerCase();
    const clean = ext.replace(/[^a-z0-9.]/g, "");
    if (!clean || clean === "." || clean.length > 12) return ".bin";
    return clean;
}

function displayName(originalName) {
    const cleaned = decodeMultipartName(originalName)
        .replace(/[\\/:*?"<>|]/g, "")
        .replace(/[\u0000-\u001f]/g, "")
        .trim()
        .slice(0, 180);
    return cleaned || "файл";
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const now = new Date();
        const monthDir = path.join(UPLOADS_DIR, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
        try {
            fs.mkdirSync(monthDir, { recursive: true });
            cb(null, monthDir);
        } catch (error) { cb(error); }
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${safeExtension(file.originalname)}`);
    }
});

// Без fileFilter — принимаем любые типы файлов.
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE, files: 1 } });

/* ---------- Вспомогательное ---------- */

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
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; font-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
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
    db.deleteExpiredSessions();
    // Не больше 5 активных сессий на пользователя: самые старые отключаем.
    const existing = db.listUserSessions(userId);
    for (let i = 5; i < existing.length; i += 1) db.deleteSession(existing[i].token);
    db.createSession(tokenHash, userId, expiresAt);
    return token;
}

function getUserByToken(token) {
    if (!token || typeof token !== "string" || token.length > 256) return null;
    return db.findUserBySession(hashToken(token));
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
    return value.length >= 8 && Buffer.byteLength(value, "utf8") <= 72;
}
function validLoginPassword(password) {
    const value = String(password || "");
    return value.length > 0 && Buffer.byteLength(value, "utf8") <= 72;
}

function notifyFriends(userId, event, payload) {
    db.listFriendIds(userId).forEach((friendId) => io.to(`user:${friendId}`).emit(event, payload));
}

/* ---------- Маршруты ---------- */

app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

/**
 * Версии зависимостей читаем прямо из node_modules, а не через
 * require("имя/package.json"): у части пакетов поле exports такой импорт запрещает.
 * Нужно, чтобы можно было убедиться, что на хостинге стоит именно та версия,
 * которую обновили, а не старая уязвимая.
 */
function depVersion(name) {
    try {
        const file = path.join(__dirname, "..", "node_modules", name, "package.json");
        return JSON.parse(fs.readFileSync(file, "utf8")).version;
    } catch (error) {
        return "unknown";
    }
}

app.get("/api/status", (req, res) => res.json({
    ok: true,
    server: "ИПК",
    version: "2.4.1",
    db: "file-json",
    dataDir: db.DATA_DIR,
    persistent: db.PERSISTENT,
    uploadsReady: uploadsReady === null ? fs.existsSync(UPLOADS_DIR) : uploadsReady,
    maxFileSize: MAX_FILE_SIZE,
    node: process.version,
    deps: {
        express: depVersion("express"),
        socketio: depVersion("socket.io"),
        multer: depVersion("multer"),
        bcryptjs: depVersion("bcryptjs")
    },
    data: db.getStats(),
    time: new Date().toISOString()
}));

app.get("/api/health", (req, res) => res.json({
    ok: true,
    status: "healthy",
    db: "file-json",
    uptime: process.uptime()
}));

app.post("/api/register", authLimiter, async (req, res) => {
    try {
        const username = normalizeUsername(req.body?.username);
        const password = String(req.body?.password || "");
        if (!validUsername(username)) return sendError(res, 400, "Никнейм: 3–24 символа, только буквы, цифры и _");
        if (!validPassword(password)) return sendError(res, 400, "Пароль должен содержать минимум 8 символов и не превышать 72 байта");
        if (db.findByUsername(username)) return sendError(res, 409, "Такой никнейм уже занят");
        const passwordHash = await bcrypt.hash(password, 12);
        const user = db.createUser(username, passwordHash);
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
        const user = db.findByUsername(username);
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
    db.deleteSession(req.sessionHash);
    const sockets = await io.in(`user:${req.user.id}`).fetchSockets();
    sockets.filter((socket) => socket.sessionHash === req.sessionHash).forEach((socket) => socket.disconnect(true));
    res.json({ ok: true });
});

app.put("/api/profile", auth, (req, res) => {
    try {
        const username = normalizeUsername(req.body?.username);
        if (!validUsername(username)) return sendError(res, 400, "Никнейм: 3–24 символа, только буквы, цифры и _");
        if (db.usernameTakenByOther(username, req.user.id)) return sendError(res, 409, "Такой никнейм уже занят");
        db.updateUsername(req.user.id, username);
        const user = db.findUserById(req.user.id);
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
    const users = db.searchUsers(req.user.id, q, 20);
    res.json({ ok: true, users: users.map((user) => ({ ...publicUser(user), relation: user.relation })) });
});

app.get("/api/friends", auth, (req, res) => {
    const friends = db.listFriendsWithMeta(req.user.id);
    res.json({
        ok: true,
        friends: friends.map((friend) => ({
            ...publicUser(friend),
            last_message: friend.last_message || "",
            last_message_at: friend.last_message_at || "",
            unread_count: Number(friend.unread_count) || 0,
            last_seen: friend.last_seen || ""
        }))
    });
});

app.post("/api/friends/request", auth, (req, res) => {
    const targetId = Number(req.body?.userId);
    if (!Number.isSafeInteger(targetId) || targetId <= 0) return sendError(res, 400, "Некорректный пользователь");
    if (targetId === req.user.id) return sendError(res, 400, "Нельзя добавить самого себя");
    const target = db.findUserById(targetId);
    if (!target) return sendError(res, 404, "Пользователь не найден");
    if (db.areFriends(req.user.id, targetId)) return sendError(res, 409, "Вы уже друзья");

    const reverse = db.findRequestBetween(targetId, req.user.id);
    if (reverse && reverse.status === "pending") return sendError(res, 409, "Этот пользователь уже отправил тебе заявку");

    const existing = db.findRequestBetween(req.user.id, targetId);
    if (existing && existing.status === "pending") return sendError(res, 409, "Заявка уже отправлена");
    if (existing) db.setFriendRequestStatus(existing.id, "pending");
    else db.createFriendRequest(req.user.id, targetId);

    io.to(`user:${targetId}`).emit("friend:request", publicUser(req.user));
    res.status(201).json({ ok: true, message: "Заявка отправлена" });
});

app.get("/api/friends/requests", auth, (req, res) => {
    res.json({ ok: true, requests: db.listPendingRequests(req.user.id) });
});

app.post("/api/friends/accept", auth, (req, res) => {
    const requestId = Number(req.body?.requestId);
    if (!Number.isSafeInteger(requestId)) return sendError(res, 400, "Некорректная заявка");
    const request = db.findPendingRequestById(requestId, req.user.id);
    if (!request) return sendError(res, 404, "Заявка не найдена");
    db.setFriendRequestStatus(request.id, "accepted");
    db.addFriend(request.sender_id, request.receiver_id);
    db.addFriend(request.receiver_id, request.sender_id);
    io.to(`user:${request.sender_id}`).emit("friend:accepted", publicUser(req.user));
    res.json({ ok: true });
});

app.post("/api/friends/reject", auth, (req, res) => {
    const requestId = Number(req.body?.requestId);
    if (!Number.isSafeInteger(requestId)) return sendError(res, 400, "Некорректная заявка");
    const request = db.findPendingRequestById(requestId, req.user.id);
    if (!request) return sendError(res, 404, "Заявка не найдена");
    db.setFriendRequestStatus(request.id, "rejected");
    res.json({ ok: true });
});

app.delete("/api/friends/:userId", auth, (req, res) => {
    const friendId = Number(req.params.userId);
    if (!Number.isSafeInteger(friendId) || friendId <= 0) return sendError(res, 400, "Некорректный пользователь");
    db.removeFriendBoth(req.user.id, friendId);
    db.deleteRequestsBetween(req.user.id, friendId);
    io.to(`user:${friendId}`).emit("friend:removed", { userId: req.user.id });
    res.json({ ok: true });
});

app.get("/api/messages/:userId", auth, (req, res) => {
    const otherId = Number(req.params.userId);
    const before = req.query.before ? Number(req.query.before) : null;
    if (!Number.isSafeInteger(otherId) || otherId <= 0) return sendError(res, 400, "Некорректный пользователь");
    if (!db.areFriends(req.user.id, otherId)) return sendError(res, 403, "Переписка доступна только друзьям");
    if (before !== null && (!Number.isSafeInteger(before) || before <= 0)) return sendError(res, 400, "Некорректный курсор");
    const history = db.listMessages(req.user.id, otherId, before, 100);
    res.json({ ok: true, messages: history, hasMore: history.length === 100 });
});

app.post("/api/messages", auth, messageLimiter, (req, res) => {
    const receiverId = Number(req.body?.receiverId);
    const text = String(req.body?.text || "").trim();
    if (!Number.isSafeInteger(receiverId) || receiverId <= 0) return sendError(res, 400, "Некорректный получатель");
    if (!text) return sendError(res, 400, "Сообщение пустое");
    if (text.length > 5000) return sendError(res, 400, "Сообщение слишком длинное");
    if (!db.areFriends(req.user.id, receiverId)) return sendError(res, 403, "Писать можно только друзьям");

    const message = db.createMessage({ senderId: req.user.id, receiverId, text, messageType: "text" });
    io.to(`user:${receiverId}`).emit("message:new", message);
    io.to(`user:${req.user.id}`).emit("message:sent", message);
    res.status(201).json({ ok: true, message });
});

app.post("/api/messages/:userId/read", auth, (req, res) => {
    const senderId = Number(req.params.userId);
    if (!Number.isSafeInteger(senderId) || senderId <= 0) return sendError(res, 400, "Некорректный пользователь");
    if (!db.areFriends(req.user.id, senderId)) return sendError(res, 403, "Недоступно");
    const updated = db.markMessagesRead(senderId, req.user.id);
    if (updated) io.to(`user:${senderId}`).emit("messages:read", { userId: req.user.id });
    res.json({ ok: true, updated });
});

app.delete("/api/messages/:messageId", auth, (req, res) => {
    const messageId = Number(req.params.messageId);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return sendError(res, 400, "Некорректное сообщение");
    const message = db.findMessageById(messageId);
    if (!message) return sendError(res, 404, "Сообщение не найдено");
    if (Number(message.sender_id) !== Number(req.user.id)) return sendError(res, 403, "Можно удалять только свои сообщения");
    db.deleteMessage(messageId);
    io.to(`user:${message.receiver_id}`).emit("message:deleted", { id: messageId });
    io.to(`user:${req.user.id}`).emit("message:deleted", { id: messageId });
    res.json({ ok: true });
});

app.post("/api/upload", auth, messageLimiter, upload.single("file"), (req, res) => {
    try {
        if (!ensureUploadsDir()) return sendError(res, 503, "Хранилище файлов недоступно на сервере");
        if (!req.file) return sendError(res, 400, "Файл не загружен");
        const receiverId = Number(req.body?.receiverId);
        if (!Number.isSafeInteger(receiverId) || receiverId <= 0) return sendError(res, 400, "Некорректный получатель");
        if (!db.areFriends(req.user.id, receiverId)) return sendError(res, 403, "Отправлять файлы можно только друзьям");

        const fileName = displayName(req.file.originalname);
        const fileUrl = `/api/files/${path.basename(req.file.path)}`;
        const message = db.createMessage({
            senderId: req.user.id,
            receiverId,
            text: "",
            messageType: "file",
            fileName,
            fileUrl,
            fileSize: req.file.size
        });
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

    let filePath = null;
    try {
        const months = fs.readdirSync(UPLOADS_DIR, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort()
            .reverse();
        for (const month of months) {
            const candidate = path.join(UPLOADS_DIR, month, filename);
            if (fs.existsSync(candidate)) { filePath = candidate; break; }
        }
    } catch (error) {
        console.error("FILE LOOKUP ERROR:", error);
    }
    if (!filePath) return sendError(res, 404, "Файл не найден");

    const fileUrl = `/api/files/${filename}`;
    if (!db.canAccessFile(fileUrl, req.user.id)) return sendError(res, 403, "Доступ запрещён");

    const meta = db.findFileByUrl(fileUrl);
    const downloadName = (meta && meta.file_name) || filename;
    const ext = path.extname(filename).toLowerCase();
    const disposition = INLINE_IMAGE_EXTENSIONS.includes(ext) ? "inline" : "attachment";
    res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (meta && meta.file_size) res.setHeader("Content-Length", String(meta.file_size));
    res.sendFile(filePath);
});

/* ---------- Реальное время ---------- */

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
        db.updateLastSeen(userId, new Date().toISOString());
        notifyFriends(userId, "user:online", { userId });
    }

    const sendPresence = () => {
        const onlineFriendIds = db.listFriendIds(userId).filter((friendId) => onlineUsers.has(friendId));
        socket.emit("presence:snapshot", { userIds: onlineFriendIds });
    };
    sendPresence();
    socket.on("presence:get", sendPresence);

    let lastTypingAt = 0;
    const relayTyping = (event, payload) => {
        const receiverId = Number(payload?.receiverId);
        if (!Number.isSafeInteger(receiverId) || !db.areFriends(userId, receiverId)) return;
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
            db.updateLastSeen(userId, lastSeen);
            notifyFriends(userId, "user:offline", { userId, last_seen: lastSeen });
        }
    });
});

/* ---------- Заглушки и ошибки ---------- */

app.use((req, res) => {
    if (req.path.startsWith("/api/")) return sendError(res, 404, "Маршрут не найден");
    res.status(404).sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use((error, req, res, next) => {
    if (error instanceof SyntaxError && "body" in error) return sendError(res, 400, "Некорректный JSON");
    if (error && error.code === "LIMIT_FILE_SIZE") {
        return sendError(res, 413, `Файл больше ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} МБ`);
    }
    if (error && error.code === "LIMIT_FILE_COUNT") return sendError(res, 400, "Можно прикрепить только один файл");
    console.error("UNHANDLED ERROR:", error);
    return sendError(res, 500, "Внутренняя ошибка сервера");
});

server.listen(PORT, HOST, () => {
    console.log(`ИПК запущен: http://${HOST}:${PORT} (данные: ${db.DB_FILE})`);
});

function shutdown() {
    try { db.close(); } catch (error) { console.error("DB CLOSE ERROR:", error.message); }
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
