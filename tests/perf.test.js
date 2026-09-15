"use strict";
/**
 * Замер скорости списка друзей на большой базе.
 * Сравниваем прежний подход (отдельный проход по всем сообщениям на каждого
 * друга) с новым (один проход по всем сообщениям).
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

const dataDir = path.join(os.tmpdir(), `ipk-perf-${Date.now()}`);
process.env.IPK_DATA_DIR = dataDir;
fs.mkdirSync(dataDir, { recursive: true });

const FRIENDS = 20;
const MESSAGES = 100000;
const now = new Date().toISOString();

const store = {
    version: 2,
    counters: { userId: FRIENDS + 2, requestId: 1, messageId: MESSAGES + 1, friendId: FRIENDS + 1 },
    users: {}, sessions: {}, friendRequests: {}, friends: {}, messages: {}
};

for (let i = 1; i <= FRIENDS + 1; i += 1) {
    store.users[i] = { id: i, username: `user${i}`, password: "x", avatar: "", created_at: now, last_seen: null };
}
for (let i = 2; i <= FRIENDS + 1; i += 1) {
    store.friends[`1_${i}`] = { id: i, user_id: 1, friend_id: i, created_at: now };
    store.friends[`${i}_1`] = { id: i, user_id: i, friend_id: 1, created_at: now };
}
for (let m = 1; m <= MESSAGES; m += 1) {
    const peer = 2 + (m % FRIENDS);
    const fromMe = m % 2 === 0;
    store.messages[m] = {
        id: m,
        sender_id: fromMe ? 1 : peer,
        receiver_id: fromMe ? peer : 1,
        text: `сообщение ${m}`,
        message_type: "text",
        file_name: "",
        file_url: "",
        file_size: 0,
        is_read: fromMe ? 1 : 0,
        created_at: now
    };
}

const storePath = path.join(dataDir, "ipk-store.db");
fs.writeFileSync(storePath, JSON.stringify(store), "utf8");
const sizeMb = (fs.statSync(storePath).size / 1024 / 1024).toFixed(1);

const modulePath = path.join(__dirname, "..", "server", "database-sqlite.js");

console.log(`Друзей: ${FRIENDS}, сообщений: ${MESSAGES}, размер базы: ${sizeMb} МБ`);

// Замер загрузки модуля (чтение и разбор файла)
let t = Date.now();
delete require.cache[require.resolve(modulePath)];
const db = require(modulePath);
console.log(`Загрузка базы в память: ${Date.now() - t} мс`);
console.log("");

// «Было»: на каждого друга — свой проход по всем сообщениям
t = Date.now();
let total = 0;
for (let i = 2; i <= FRIENDS + 1; i += 1) total += db.listMessages(1, i, null, 1).length;
const beforeMs = Date.now() - t;

// «Стало»: один проход
t = Date.now();
const friends = db.listFriendsWithMeta(1);
const afterMs = Date.now() - t;

// Поиск
t = Date.now();
const found = db.searchUsers(1, "user");
const searchMs = Date.now() - t;

console.log(`Список друзей — прежний подход (проход на каждого друга): ${beforeMs} мс`);
console.log(`Список друзей — новый подход (один проход):               ${afterMs} мс`);
console.log(`Поиск пользователей (все 21, связи собраны один раз):     ${searchMs} мс`);
console.log("");
console.log(`Ускорение списка друзей: ${afterMs > 0 ? (beforeMs / afterMs).toFixed(1) : "более 100"}x`);
console.log(`Друзей в ответе: ${friends.length}, найдено при поиске: ${found.length}`);
console.log(`Непрочитанных у первого друга: ${friends[0] ? friends[0].unread_count : "-"}`);

db.close();
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
