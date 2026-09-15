"use strict";
/* Проверяем: поднимается ли сервер, если каталог данных недоступен для записи. */

const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");

const PROJECT = path.join(__dirname, "..");
const badPath = path.join(os.tmpdir(), "ipk-baddir-file");
const PORT = 37893;

try { fs.rmSync(badPath, { recursive: true, force: true }); } catch (e) { /* ignore */ }
fs.writeFileSync(badPath, "this is a FILE, not a directory");

console.log(`Вместо каталога данных подставляю файл: ${badPath}`);
console.log(`Проект: ${PROJECT}`);
console.log("");

const child = spawn(process.execPath, [path.join(PROJECT, "server", "server-sqlite.js")], {
    cwd: PROJECT,
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: "127.0.0.1", IPK_DATA_DIR: badPath }),
    stdio: ["ignore", "pipe", "pipe"]
});

let log = "";
let exited = false;
child.stdout.on("data", (d) => { log += d.toString(); });
child.stderr.on("data", (d) => { log += d.toString(); });
child.on("exit", (code) => { exited = true; log += `\n[процесс завершился, код ${code}]`; });

(async () => {
    let healthy = false;
    for (let i = 0; i < 30; i += 1) {
        if (exited) break;
        try {
            const response = await fetch(`http://127.0.0.1:${PORT}/api/health`);
            if (response.ok) { healthy = true; break; }
        } catch (error) { /* ещё поднимается */ }
        await new Promise((resolve) => setTimeout(resolve, 400));
    }

    console.log("--- лог сервера ---");
    console.log(log.trim());
    console.log("");

    if (healthy) {
        const status = await (await fetch(`http://127.0.0.1:${PORT}/api/status`)).json();
        console.log("РЕЗУЛЬТАТ: сервер ПОДНЯЛСЯ, несмотря на недоступный каталог");
        console.log(`  каталог данных : ${status.dataDir}`);
        console.log(`  постоянный     : ${status.persistent}`);
        console.log(`  вложения готовы: ${status.uploadsReady}`);
    } else {
        console.log("РЕЗУЛЬТАТ: сервер УПАЛ — именно это даёт 502 на хостинге");
    }

    child.kill();
    try { fs.rmSync(badPath, { force: true }); } catch (e) { /* ignore */ }
    process.exit(healthy ? 0 : 1);
})();
