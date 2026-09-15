"use strict";
/* Проверка постоянного слоя данных ИПК. Запуск: node ipk-db-test.js */

const path = require("path");
const os = require("os");
const fs = require("fs");
const assert = require("assert");

const dataDir = path.join(os.tmpdir(), `ipk-dbtest-${Date.now()}`);
process.env.IPK_DATA_DIR = dataDir;

const modulePath = path.join(__dirname, "..", "server", "database-sqlite.js");

function fresh() {
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath);
}

let passed = 0;
function check(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  OK   ${name}`);
    } catch (error) {
        console.log(`  FAIL ${name}`);
        console.log(`       ${error.message}`);
        process.exitCode = 1;
    }
}

console.log(`Модуль: ${modulePath}`);
console.log(`Данные: ${dataDir}`);
console.log("");

const db = fresh();

const alice = db.createUser("alice", "hash-a");
const bob = db.createUser("bob", "hash-b");

check("пользователь создаётся, поиск без учёта регистра", () => {
    assert.strictEqual(db.findByUsername("ALICE").id, alice.id);
});
check("дубликат ника ловится, свой ник не считается дубликатом", () => {
    assert.ok(db.usernameTakenByOther("alice", bob.id));
    assert.strictEqual(db.usernameTakenByOther("alice", alice.id), false);
});
check("переименование", () => {
    db.updateUsername(bob.id, "bobby");
    assert.strictEqual(db.findUserById(bob.id).username, "bobby");
    db.updateUsername(bob.id, "bob");
});

db.createSession("hash-token", alice.id, new Date(Date.now() + 86400000).toISOString());
check("сессия находится по хешу", () => {
    const session = db.findUserBySession("hash-token");
    assert.ok(session && session.username === "alice");
    assert.strictEqual(session.session_hash, "hash-token");
});
check("истёкшая сессия не находится", () => {
    db.createSession("hash-old", alice.id, new Date(Date.now() - 1000).toISOString());
    assert.strictEqual(db.findUserBySession("hash-old"), null);
    db.deleteExpiredSessions();
});

const request = db.createFriendRequest(alice.id, bob.id);
check("заявка видна получателю", () => {
    assert.strictEqual(db.listPendingRequests(bob.id).length, 1);
    assert.strictEqual(db.listPendingRequests(alice.id).length, 0);
});
check("ПРИЁМ заявки убирает её из списка (был баг)", () => {
    assert.strictEqual(db.setFriendRequestStatus(request.id, "accepted"), 1);
    assert.strictEqual(db.listPendingRequests(bob.id).length, 0);
});
check("ПОВТОРНАЯ заявка после отклонения проходит (был баг)", () => {
    const again = db.createFriendRequest(bob.id, alice.id);
    assert.strictEqual(db.setFriendRequestStatus(again.id, "rejected"), 1);
    assert.strictEqual(db.findPendingRequestById(again.id, alice.id), null);
    assert.strictEqual(db.setFriendRequestStatus(again.id, "pending"), 1);
    assert.strictEqual(db.findPendingRequestById(again.id, alice.id).status, "pending");
});

db.addFriend(alice.id, bob.id);
db.addFriend(bob.id, alice.id);
check("дружба двусторонняя", () => {
    assert.ok(db.areFriends(alice.id, bob.id));
    assert.ok(db.areFriends(bob.id, alice.id));
    assert.deepStrictEqual(db.listFriendIds(alice.id), [bob.id]);
});

const text = db.createMessage({ senderId: alice.id, receiverId: bob.id, text: "привет" });
const file = db.createMessage({
    senderId: bob.id, receiverId: alice.id, text: "", messageType: "file",
    fileName: "документ.pdf", fileUrl: "/api/files/abc.pdf", fileSize: 1234
});
check("текстовое сообщение", () => {
    assert.strictEqual(text.text, "привет");
    assert.strictEqual(text.message_type, "text");
    assert.strictEqual(text.is_read, 0);
});
check("ВЛОЖЕНИЕ: поля на своих местах (был баг)", () => {
    assert.strictEqual(file.text, "", "текст должен быть пустым");
    assert.strictEqual(file.message_type, "file");
    assert.strictEqual(file.file_name, "документ.pdf");
    assert.strictEqual(file.file_url, "/api/files/abc.pdf");
    assert.strictEqual(file.file_size, 1234);
});
check("ДОСТУП к файлу: своим да, чужому нет (был баг)", () => {
    assert.strictEqual(db.canAccessFile("/api/files/abc.pdf", alice.id), true);
    assert.strictEqual(db.canAccessFile("/api/files/abc.pdf", bob.id), true);
    assert.strictEqual(db.canAccessFile("/api/files/abc.pdf", 9999), false);
    assert.strictEqual(db.findFileByUrl("/api/files/abc.pdf").file_name, "документ.pdf");
});
check("список друзей: последнее сообщение и счётчик непрочитанных", () => {
    const friends = db.listFriendsWithMeta(alice.id);
    assert.strictEqual(friends.length, 1);
    assert.strictEqual(friends[0].unread_count, 1);
    assert.strictEqual(friends[0].last_message, "");
});
check("прочитано сбрасывает счётчик", () => {
    assert.strictEqual(db.markMessagesRead(bob.id, alice.id), 1);
    assert.strictEqual(db.listFriendsWithMeta(alice.id)[0].unread_count, 0);
});
check("история переписки по возрастанию id", () => {
    const history = db.listMessages(alice.id, bob.id);
    assert.strictEqual(history.length, 2);
    assert.ok(history[0].id < history[1].id);
});
check("история: курсор before", () => {
    assert.strictEqual(db.listMessages(alice.id, bob.id, file.id).length, 1);
});
check("поиск пользователей и связь relation", () => {
    const found = db.searchUsers(alice.id, "bob");
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].relation, "friend");
    assert.strictEqual(db.searchUsers(alice.id, "zzz").length, 0);
});
check("профиль: поиск по части ника", () => {
    assert.strictEqual(db.searchUsers(alice.id, "OB").length, 1);
});

console.log("");
console.log("--- ГЛАВНАЯ ПРОВЕРКА: перезапуск процесса ---");
db.close();

const db2 = fresh();
check("пользователи пережили перезапуск", () => {
    assert.ok(db2.findByUsername("alice"));
    assert.ok(db2.findByUsername("bob"));
    assert.strictEqual(db2.findUserById(alice.id).password, "hash-a");
});
check("сессия пережила перезапуск (вход сохраняется)", () => {
    assert.ok(db2.findUserBySession("hash-token"));
});
check("дружба пережила перезапуск", () => {
    assert.ok(db2.areFriends(alice.id, bob.id));
});
check("ПЕРЕПИСКА пережила перезапуск — то, из-за чего всё терялось", () => {
    assert.strictEqual(db2.listMessages(alice.id, bob.id).length, 2);
    assert.strictEqual(db2.findMessageById(file.id).file_name, "документ.pdf");
    assert.strictEqual(db2.findMessageById(text.id).text, "привет");
});
check("счётчики id не сбросились (нет перезаписи сообщений)", () => {
    const next = db2.createMessage({ senderId: alice.id, receiverId: bob.id, text: "третье" });
    assert.ok(next.id > file.id, `новый id ${next.id} должен быть больше ${file.id}`);
});
db2.close();

const stats = db2.getStats();
console.log("");
console.log(`Итог: ${passed} проверок пройдено`);
console.log(`Состояние хранилища: ${JSON.stringify(stats)}`);

try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
console.log(process.exitCode ? "РЕЗУЛЬТАТ: ЕСТЬ ОШИБКИ" : "РЕЗУЛЬТАТ: ВСЁ ЗЕЛЁНОЕ");
