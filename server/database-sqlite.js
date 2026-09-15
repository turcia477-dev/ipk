"use strict";

/**
 * ИПК — постоянный слой данных.
 *
 * Заменяет прежний самодельный эмулятор SQL (который угадывал смысл запроса
 * по началу строки и на любом непонятном запросе молча возвращал пустоту).
 * Теперь это обычные функции с внятными именами.
 *
 * Хранение: JSON-файл на диске. Пишем атомарно (временный файл + rename),
 * с задержкой 200 мс при частых изменениях и принудительным сбросом
 * при остановке процесса. Никаких нативных зависимостей — важно, потому что
 * better-sqlite3 и sql.js на бесплатном тарифе Bonto не собираются.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const FLUSH_DEBOUNCE_MS = 200;
const PROJECT_DATA_DIR = path.join(__dirname, "..", "data");

/**
 * Проверяем доступность каталога БЕЗ создания и удаления файлов.
 * На Bonto приложение запускается через nodemon, который следит за файлами:
 * любой созданный или удалённый файл вызывает перезапуск сервера.
 */
function isWritableDir(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
    } catch (error) {
        console.error(`  каталог недоступен для записи: ${dir} (${error.code || error.message})`);
        return false;
    }
}

/**
 * Ищем первое место, куда реально можно писать.
 * Падать на старте нельзя: если процесс умирает, хостинг отдаёт 502
 * и мессенджер становится недоступен целиком. Лучше работать без
 * сохранения на диск, чем не работать вовсе.
 */
function resolveDataDir() {
    const candidates = [];
    if (process.env.IPK_DATA_DIR) candidates.push(process.env.IPK_DATA_DIR);
    candidates.push(PROJECT_DATA_DIR);
    candidates.push(path.join(os.tmpdir(), "ipk-data"));
    for (const dir of candidates) {
        if (isWritableDir(dir)) return dir;
    }
    return path.join(os.tmpdir(), "ipk-data");
}

const DATA_DIR = resolveDataDir();
const PERSISTENT = process.env.IPK_DATA_DIR ? true : DATA_DIR === PROJECT_DATA_DIR;
// Расширение .db выбрано намеренно. nodemon следит за файлами .js и .json,
// поэтому база в .json вызывала бы перезапуск сервера на каждом сообщении.
const DB_FILE = path.join(DATA_DIR, "ipk-store.db");
const LEGACY_DB_FILE = path.join(DATA_DIR, "ipk-store.json");
const TMP_FILE = `${DB_FILE}.tmp`;

console.log(`Каталог данных: ${DATA_DIR}`);
if (!PERSISTENT) {
    console.error("ВНИМАНИЕ: данные пишутся во временный каталог — после перезапуска они не сохранятся.");
}

function emptyState() {
    return {
        version: 2,
        counters: { userId: 1, requestId: 1, messageId: 1, friendId: 1 },
        users: {},
        sessions: {},
        friendRequests: {},
        friends: {},
        messages: {}
    };
}

let state = emptyState();
let flushTimer = null;
let dirty = false;

function friendKey(userId, friendId) {
    return `${Number(userId)}_${Number(friendId)}`;
}

function nowIso() {
    return new Date().toISOString();
}

/* ---------- Загрузка и сохранение ---------- */

function readStoreFile(file) {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
}

/**
 * Повреждённый файл не затираем, а откладываем в сторону.
 * Иначе одна битая запись означала бы безвозвратную потерю всей переписки.
 * Расширение .corrupt-… выбрано, чтобы nodemon не принял это за изменение кода.
 */
function quarantine(file) {
    try {
        const target = `${file}.corrupt-${Date.now()}`;
        fs.renameSync(file, target);
        console.error(`Повреждённый файл сохранён как ${target}`);
    } catch (error) {
        console.error(`Не удалось отложить повреждённый файл ${file}: ${error.message}`);
    }
}

function applyParsed(parsed) {
    const base = emptyState();
    state = {
        version: 2,
        counters: Object.assign(base.counters, parsed.counters || {}),
        users: parsed.users || {},
        sessions: parsed.sessions || {},
        friendRequests: parsed.friendRequests || {},
        friends: parsed.friends || {},
        messages: parsed.messages || {}
    };
    pruneExpiredSessions();
}

function load() {
    for (const file of [DB_FILE, LEGACY_DB_FILE]) {
        if (!fs.existsSync(file)) continue;
        try {
            const parsed = readStoreFile(file);
            if (!parsed) continue;
            applyParsed(parsed);
            console.log(`Хранилище загружено: ${file}`);
            return;
        } catch (error) {
            console.error(`Не удалось прочитать ${file}: ${error.message}`);
            quarantine(file);
        }
    }
    state = emptyState();
}

function flushSync() {
    if (!dirty) return;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(TMP_FILE, JSON.stringify(state), "utf8");
        fs.renameSync(TMP_FILE, DB_FILE);
        dirty = false;
    } catch (error) {
        console.error("Не удалось сохранить хранилище:", error.message);
    }
}

/**
 * По умолчанию пишем на диск сразу же: сообщение не должно потеряться, если
 * контейнер уснёт или его прибьют через секунду после отправки.
 * Для некритичных обновлений (отметка «был в сети») передаём false — тогда
 * запись склеивается и уходит раз в FLUSH_DEBOUNCE_MS.
 */
function scheduleFlush(immediate = true) {
    dirty = true;
    if (immediate) {
        flushSync();
        return;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushSync();
    }, FLUSH_DEBOUNCE_MS);
}

function close() {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    flushSync();
}

/* ---------- Пользователи ---------- */

function findByUsername(username) {
    const needle = String(username || "").toLowerCase();
    if (!needle) return null;
    for (const user of Object.values(state.users)) {
        if (user.username.toLowerCase() === needle) return user;
    }
    return null;
}

function createUser(username, passwordHash) {
    const id = state.counters.userId++;
    state.users[id] = {
        id,
        username,
        password: passwordHash,
        avatar: "",
        created_at: nowIso(),
        last_seen: null
    };
    scheduleFlush();
    return state.users[id];
}

function findUserById(id) {
    return state.users[Number(id)] || null;
}

function findUserWithPasswordByUsername(username) {
    return findByUsername(username);
}

function usernameTakenByOther(username, userId) {
    const user = findByUsername(username);
    return Boolean(user && Number(user.id) !== Number(userId));
}

function updateUsername(userId, username) {
    const user = state.users[Number(userId)];
    if (!user) return 0;
    user.username = username;
    scheduleFlush();
    return 1;
}

function updateLastSeen(userId, iso) {
    const user = state.users[Number(userId)];
    if (!user) return 0;
    user.last_seen = iso;
    // Некритично: при частых переподключениях запись склеивается.
    scheduleFlush(false);
    return 1;
}

/* ---------- Сессии ---------- */

function pruneExpiredSessions() {
    const now = Date.now();
    for (const [hash, session] of Object.entries(state.sessions)) {
        if (!session.expires_at || Date.parse(session.expires_at) <= now) {
            delete state.sessions[hash];
        }
    }
}

function deleteExpiredSessions() {
    const before = Object.keys(state.sessions).length;
    pruneExpiredSessions();
    if (Object.keys(state.sessions).length !== before) scheduleFlush(false);
}

function createSession(tokenHash, userId, expiresAt) {
    state.sessions[tokenHash] = {
        token: tokenHash,
        user_id: Number(userId),
        created_at: nowIso(),
        expires_at: expiresAt
    };
    scheduleFlush();
    return 1;
}

function deleteSession(tokenHash) {
    if (!state.sessions[tokenHash]) return 0;
    delete state.sessions[tokenHash];
    scheduleFlush();
    return 1;
}

function listUserSessions(userId) {
    const now = Date.now();
    return Object.values(state.sessions)
        .filter((s) => Number(s.user_id) === Number(userId) && s.expires_at && Date.parse(s.expires_at) > now)
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
}

function findUserBySession(tokenHash) {
    const session = state.sessions[tokenHash];
    if (!session) return null;
    if (!session.expires_at || Date.parse(session.expires_at) <= Date.now()) return null;
    const user = state.users[session.user_id];
    if (!user) return null;
    return { id: user.id, username: user.username, avatar: user.avatar || "", session_hash: tokenHash };
}

/* ---------- Друзья ---------- */

function areFriends(userId, friendId) {
    return Boolean(state.friends[friendKey(userId, friendId)]);
}

function addFriend(userId, friendId) {
    const key = friendKey(userId, friendId);
    if (state.friends[key]) return 0;
    state.friends[key] = {
        id: state.counters.friendId++,
        user_id: Number(userId),
        friend_id: Number(friendId),
        created_at: nowIso()
    };
    scheduleFlush();
    return 1;
}

function removeFriendBoth(a, b) {
    const keys = [friendKey(a, b), friendKey(b, a)];
    let removed = 0;
    for (const key of keys) {
        if (state.friends[key]) {
            delete state.friends[key];
            removed += 1;
        }
    }
    if (removed) scheduleFlush();
    return removed;
}

function listFriendIds(userId) {
    return Object.values(state.friends)
        .filter((f) => Number(f.user_id) === Number(userId))
        .map((f) => Number(f.friend_id));
}

function lastMessageBetween(a, b) {
    let best = null;
    for (const message of Object.values(state.messages)) {
        const fromA = Number(message.sender_id) === Number(a) && Number(message.receiver_id) === Number(b);
        const fromB = Number(message.sender_id) === Number(b) && Number(message.receiver_id) === Number(a);
        if (!fromA && !fromB) continue;
        if (!best || Number(message.id) > Number(best.id)) best = message;
    }
    return best;
}

function unreadFrom(senderId, receiverId) {
    let count = 0;
    for (const message of Object.values(state.messages)) {
        if (Number(message.sender_id) === Number(senderId) &&
            Number(message.receiver_id) === Number(receiverId) &&
            Number(message.is_read) === 0) count += 1;
    }
    return count;
}

function listFriendsWithMeta(userId) {
    const me = Number(userId);

    // Один проход по сообщениям вместо отдельного сканирования на каждого друга.
    // Раньше это было O(друзья × сообщения), а список пересчитывается после
    // каждого сообщения — именно из-за этого появлялись задержки.
    const lastByPeer = new Map();
    const unreadByPeer = new Map();

    for (const message of Object.values(state.messages)) {
        const sender = Number(message.sender_id);
        const receiver = Number(message.receiver_id);

        if (sender === me) {
            const current = lastByPeer.get(receiver);
            if (!current || Number(message.id) > Number(current.id)) lastByPeer.set(receiver, message);
        } else if (receiver === me) {
            const current = lastByPeer.get(sender);
            if (!current || Number(message.id) > Number(current.id)) lastByPeer.set(sender, message);
            if (Number(message.is_read) === 0) unreadByPeer.set(sender, (unreadByPeer.get(sender) || 0) + 1);
        }
    }

    const result = [];
    for (const link of Object.values(state.friends)) {
        if (Number(link.user_id) !== me) continue;
        const friend = state.users[link.friend_id];
        if (!friend) continue;
        const friendId = Number(friend.id);
        const last = lastByPeer.get(friendId) || null;
        result.push({
            id: friend.id,
            username: friend.username,
            avatar: friend.avatar || "",
            last_seen: friend.last_seen || "",
            last_message: last ? last.text : "",
            last_message_at: last ? last.created_at : "",
            unread_count: unreadByPeer.get(friendId) || 0,
            _sortAt: (last && last.created_at) || link.created_at || ""
        });
    }
    result.sort((a, b) => String(b._sortAt).localeCompare(String(a._sortAt)));
    result.forEach((row) => delete row._sortAt);
    return result;
}

/* ---------- Поиск пользователей ---------- */

function searchUsers(meId, query, limit = 20) {
    const me = Number(meId);
    const needle = String(query || "").toLowerCase();
    if (!needle) return [];

    // Связи с текущим пользователем собираем один раз, а не перебором всех
    // заявок для каждого найденного человека.
    const sentTo = new Set();
    const receivedFrom = new Set();
    for (const request of Object.values(state.friendRequests)) {
        if (request.status !== "pending") continue;
        const sender = Number(request.sender_id);
        const receiver = Number(request.receiver_id);
        if (sender === me) sentTo.add(receiver);
        else if (receiver === me) receivedFrom.add(sender);
    }

    const result = [];
    for (const user of Object.values(state.users)) {
        const id = Number(user.id);
        if (id === me) continue;
        if (!user.username.toLowerCase().includes(needle)) continue;

        let relation = "none";
        if (areFriends(me, id)) relation = "friend";
        else if (sentTo.has(id)) relation = "sent";
        else if (receivedFrom.has(id)) relation = "received";

        result.push({ id: user.id, username: user.username, avatar: user.avatar || "", relation });
    }
    result.sort((a, b) => {
        const aExact = a.username.toLowerCase() === needle ? 0 : 1;
        const bExact = b.username.toLowerCase() === needle ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        return a.username.localeCompare(b.username, "ru");
    });
    return result.slice(0, limit);
}

/* ---------- Заявки в друзья ---------- */

function findRequestBetween(senderId, receiverId) {
    for (const request of Object.values(state.friendRequests)) {
        if (Number(request.sender_id) === Number(senderId) &&
            Number(request.receiver_id) === Number(receiverId)) return request;
    }
    return null;
}

function findPendingRequestById(requestId, receiverId) {
    const request = state.friendRequests[Number(requestId)];
    if (!request) return null;
    if (Number(request.receiver_id) !== Number(receiverId)) return null;
    if (request.status !== "pending") return null;
    return request;
}

function createFriendRequest(senderId, receiverId) {
    const id = state.counters.requestId++;
    state.friendRequests[id] = {
        id,
        sender_id: Number(senderId),
        receiver_id: Number(receiverId),
        status: "pending",
        created_at: nowIso()
    };
    scheduleFlush();
    return state.friendRequests[id];
}

function setFriendRequestStatus(requestId, status) {
    const request = state.friendRequests[Number(requestId)];
    if (!request) return 0;
    request.status = status;
    request.updated_at = nowIso();
    if (status === "pending") request.created_at = nowIso();
    scheduleFlush();
    return 1;
}

function listPendingRequests(receiverId) {
    return Object.values(state.friendRequests)
        .filter((r) => Number(r.receiver_id) === Number(receiverId) && r.status === "pending")
        .map((r) => {
            const sender = state.users[r.sender_id];
            if (!sender) return null;
            return {
                id: r.id,
                user_id: sender.id,
                username: sender.username,
                avatar: sender.avatar || "",
                created_at: r.created_at
            };
        })
        .filter(Boolean)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function deleteRequestsBetween(a, b) {
    let removed = 0;
    for (const [id, request] of Object.entries(state.friendRequests)) {
        const direct = Number(request.sender_id) === Number(a) && Number(request.receiver_id) === Number(b);
        const reverse = Number(request.sender_id) === Number(b) && Number(request.receiver_id) === Number(a);
        if (direct || reverse) {
            delete state.friendRequests[id];
            removed += 1;
        }
    }
    if (removed) scheduleFlush();
    return removed;
}

/* ---------- Сообщения ---------- */

function createMessage({ senderId, receiverId, text = "", messageType = "text", fileName = "", fileUrl = "", fileSize = 0 }) {
    const id = state.counters.messageId++;
    state.messages[id] = {
        id,
        sender_id: Number(senderId),
        receiver_id: Number(receiverId),
        text: text || "",
        message_type: messageType || "text",
        file_name: fileName || "",
        file_url: fileUrl || "",
        file_size: Number(fileSize) || 0,
        is_read: 0,
        created_at: nowIso()
    };
    scheduleFlush();
    return state.messages[id];
}

function findMessageById(messageId) {
    return state.messages[Number(messageId)] || null;
}

function listMessages(userId, otherId, before = null, limit = 100) {
    const matched = [];
    for (const message of Object.values(state.messages)) {
        const direct = Number(message.sender_id) === Number(userId) && Number(message.receiver_id) === Number(otherId);
        const reverse = Number(message.sender_id) === Number(otherId) && Number(message.receiver_id) === Number(userId);
        if (!direct && !reverse) continue;
        if (before !== null && !(Number(message.id) < Number(before))) continue;
        matched.push(message);
    }
    matched.sort((a, b) => Number(b.id) - Number(a.id));
    const page = matched.slice(0, limit);
    page.sort((a, b) => Number(a.id) - Number(b.id));
    return page;
}

function markMessagesRead(senderId, receiverId) {
    let changed = 0;
    for (const message of Object.values(state.messages)) {
        if (Number(message.sender_id) === Number(senderId) &&
            Number(message.receiver_id) === Number(receiverId) &&
            Number(message.is_read) === 0) {
            message.is_read = 1;
            changed += 1;
        }
    }
    if (changed) scheduleFlush();
    return changed;
}

function deleteMessage(messageId) {
    const id = Number(messageId);
    if (!state.messages[id]) return 0;
    delete state.messages[id];
    scheduleFlush();
    return 1;
}

function canAccessFile(fileUrl, userId) {
    for (const message of Object.values(state.messages)) {
        if (message.file_url !== fileUrl) continue;
        if (Number(message.sender_id) === Number(userId) || Number(message.receiver_id) === Number(userId)) return true;
    }
    return false;
}

function findFileByUrl(fileUrl) {
    for (const message of Object.values(state.messages)) {
        if (message.file_url === fileUrl) return { file_name: message.file_name, file_size: message.file_size };
    }
    return null;
}

/* ---------- Служебное ---------- */

/** Полный снимок базы — для резервной копии. */
function exportSnapshot() {
    return JSON.stringify(state, null, 2);
}

function getStats() {
    return {
        file: DB_FILE,
        users: Object.keys(state.users).length,
        sessions: Object.keys(state.sessions).length,
        friendRequests: Object.keys(state.friendRequests).length,
        friends: Object.keys(state.friends).length,
        messages: Object.keys(state.messages).length,
        dirty
    };
}

load();

module.exports = {
    DATA_DIR,
    DB_FILE,
    PERSISTENT,
    createUser,
    findByUsername,
    findUserById,
    usernameTakenByOther,
    updateUsername,
    updateLastSeen,
    deleteExpiredSessions,
    createSession,
    deleteSession,
    listUserSessions,
    findUserBySession,
    areFriends,
    addFriend,
    removeFriendBoth,
    listFriendIds,
    listFriendsWithMeta,
    searchUsers,
    findRequestBetween,
    findPendingRequestById,
    createFriendRequest,
    setFriendRequestStatus,
    listPendingRequests,
    deleteRequestsBetween,
    createMessage,
    findMessageById,
    listMessages,
    markMessagesRead,
    deleteMessage,
    canAccessFile,
    findFileByUrl,
    exportSnapshot,
    getStats,
    flushSync,
    close
};
