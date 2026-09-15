"use strict";
/**
 * Проверяем, что сервер НЕ трогает файлы в каталоге данных при запуске.
 * Именно это вызывало бесконечный перезапуск под nodemon на Bonto:
 * любой созданный/удалённый файл = сигнал «перезапустись».
 */

const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");

const PROJECT = path.join(__dirname, "..");
const DATA_DIR = path.join(os.tmpdir(), `ipk-watch-${Date.now()}`);
const PORT = 37894;

try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
fs.mkdirSync(DATA_DIR, { recursive: true });

const events = [];
const watcher = fs.watch(DATA_DIR, { recursive: true }, (eventType, filename) => {
    events.push(`${eventType}: ${filename}`);
});

const child = spawn(process.execPath, [path.join(PROJECT, "server", "server-sqlite.js")], {
    cwd: PROJECT,
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: "127.0.0.1", IPK_DATA_DIR: DATA_DIR }),
    stdio: ["ignore", "pipe", "pipe"]
});
let log = "";
child.stdout.on("data", (d) => { log += d.toString(); });
child.stderr.on("data", (d) => { log += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    let healthy = false;
    for (let i = 0; i < 30; i += 1) {
        try {
            if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { healthy = true; break; }
        } catch (e) { /* ждём */ }
        await sleep(300);
    }
    if (!healthy) {
        console.log("Сервер не поднялся");
        console.log(log);
        child.kill(); watcher.close();
        process.exit(1);
    }

    await sleep(4000);
    const startupEvents = events.slice();

    console.log("--- лог сервера ---");
    console.log(log.trim());
    console.log("");
    console.log("=== ФАЙЛОВЫЕ СОБЫТИЯ ПРИ ЗАПУСКЕ ===");
    if (startupEvents.length === 0) {
        console.log("  (ни одного — цикл перезапуска устранён)");
    } else {
        startupEvents.forEach((e) => console.log(`  ${e}`));
    }

    // Теперь то, что должно писать: регистрация пользователя
    events.length = 0;
    const reg = await fetch(`http://127.0.0.1:${PORT}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "проверка", password: "пароль12345" })
    });
    await sleep(1200);
    console.log("");
    console.log("=== ФАЙЛОВЫЕ СОБЫТИЯ ПРИ СОХРАНЕНИИ ДАННЫХ ===");
    console.log(`  регистрация: ${reg.status}`);
    events.forEach((e) => console.log(`  ${e}`));

    const storeFile = path.join(DATA_DIR, "ipk-store.db");
    console.log("");
    console.log(`  база создана в .db (nodemon за .db не следит): ${fs.existsSync(storeFile)}`);
    const jsonLeftovers = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
    console.log(`  .json файлов в каталоге данных: ${jsonLeftovers.length ? jsonLeftovers.join(", ") : "нет"}`);

    const okStartup = startupEvents.length === 0;
    const okOnlyDb = events.every((e) => e.includes("ipk-store.db") || e.includes("ipk-store.db.tmp"));

    console.log("");
    console.log(okStartup && okOnlyDb
        ? "РЕЗУЛЬТАТ: цикл перезапуска устранён — при старте файлы не трогаются, пишется только .db"
        : "РЕЗУЛЬТАТ: ОСТАЛИСЬ ЛИШНИЕ ФАЙЛОВЫЕ СОБЫТИЯ");

    child.kill();
    watcher.close();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    process.exit(okStartup && okOnlyDb ? 0 : 1);
})();
