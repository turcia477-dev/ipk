"use strict";
/**
 * Проверяем, что повреждённая база не приводит к безвозвратной потере данных:
 * битый файл должен быть отложен в сторону, а не молча затираться.
 */

const path = require("path");
const os = require("os");
const fs = require("fs");

const dataDir = path.join(os.tmpdir(), `ipk-corrupt-${Date.now()}`);
process.env.IPK_DATA_DIR = dataDir;
fs.mkdirSync(dataDir, { recursive: true });

const modulePath = path.join(__dirname, "..", "server", "database-sqlite.js");
function fresh() {
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath);
}

let pass = 0;
let fail = 0;
function check(name, condition, extra = "") {
    if (condition) { pass += 1; console.log(`  OK   ${name}`); }
    else { fail += 1; console.log(`  FAIL ${name}${extra ? " -> " + extra : ""}`); }
}

console.log(`Каталог: ${dataDir}`);
console.log("");

// 1. Создаём нормальные данные
let db = fresh();
const user = db.createUser("важный", "хеш");
db.createMessage({ senderId: user.id, receiverId: user.id, text: "ценное сообщение" });
db.close();

const storeFile = path.join(dataDir, "ipk-store.db");
check("база создана", fs.existsSync(storeFile));

// 2. Портим файл
fs.writeFileSync(storeFile, "{ это не JSON, файл побился ", "utf8");

// 3. Перезапускаем модуль
db = fresh();

const leftovers = fs.readdirSync(dataDir);
const quarantined = leftovers.filter((f) => f.includes(".corrupt-"));
check("повреждённый файл отложен в сторону, а не потерян", quarantined.length === 1, leftovers.join(", "));

const quarantinedPath = quarantined.length ? path.join(dataDir, quarantined[0]) : null;
if (quarantinedPath) {
    const saved = fs.readFileSync(quarantinedPath, "utf8");
    check("содержимое битого файла сохранено для разбора", saved.includes("файл побился"));
}

check("модуль не упал и работает после повреждения", typeof db.createUser === "function");
const after = db.createUser("новый", "хеш2");
check("можно продолжать работать (данные пишутся заново)", db.findByUsername("новый")?.id === after.id);

// 4. Проверяем откат на запасной .json, если .db битый
fs.rmSync(storeFile, { force: true });
fs.writeFileSync(path.join(dataDir, "ipk-store.json"), JSON.stringify({
    version: 2,
    counters: { userId: 5, requestId: 1, messageId: 1, friendId: 1 },
    users: { 1: { id: 1, username: "иззапасного", password: "х", avatar: "", created_at: new Date().toISOString(), last_seen: null } },
    sessions: {}, friendRequests: {}, friends: {}, messages: {}
}), "utf8");
db = fresh();
check("если .db нет, читается запасной .json", db.findByUsername("иззапасного") !== null);

db.close();
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

console.log("");
console.log(`ИТОГ: пройдено ${pass}, провалено ${fail}`);
console.log(fail ? "РЕЗУЛЬТАТ: ЕСТЬ ОШИБКИ" : "РЕЗУЛЬТАТ: ВСЁ ЗЕЛЁНОЕ");
process.exit(fail ? 1 : 0);
