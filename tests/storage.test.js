"use strict";
/**
 * Проверяем защиту от переполнения хранилища: сервер должен отказать в загрузке
 * и убрать уже записанный файл, чтобы не забить диск и не сломать сохранение базы.
 */

const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");

const PROJECT = path.join(__dirname, "..");
const DATA_DIR = path.join(os.tmpdir(), `ipk-storage-${Date.now()}`);
const PORT = 37896;
const BASE = `http://127.0.0.1:${PORT}`;
const LIMIT = 1000; // намеренно крошечный лимит (1 КБ)

let pass = 0;
let fail = 0;
function check(name, condition, extra = "") {
    if (condition) { pass += 1; console.log(`  OK   ${name}`); }
    else { fail += 1; console.log(`  FAIL ${name}${extra ? " -> " + extra : ""}`); }
}

try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }

const child = spawn(process.execPath, [path.join(PROJECT, "server", "server-sqlite.js")], {
    cwd: PROJECT,
    env: Object.assign({}, process.env, {
        PORT: String(PORT), HOST: "127.0.0.1", IPK_DATA_DIR: DATA_DIR,
        IPK_MAX_UPLOADS_BYTES: String(LIMIT)
    }),
    stdio: ["ignore", "pipe", "pipe"]
});
let log = "";
child.stdout.on("data", (d) => { log += d.toString(); });
child.stderr.on("data", (d) => { log += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, options = {}) {
    const headers = {};
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body) headers["Content-Type"] = "application/json";
    const response = await fetch(`${BASE}${pathname}`, {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined
    });
    let data = null;
    try { data = await response.json(); } catch (e) { /* ignore */ }
    return { status: response.status, ok: response.ok, data };
}

async function upload(token, receiverId, filename, bytes) {
    const form = new FormData();
    form.append("file", new Blob([bytes]), filename);
    form.append("receiverId", String(receiverId));
    const response = await fetch(`${BASE}/api/upload`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form
    });
    let data = null;
    try { data = await response.json(); } catch (e) { /* ignore */ }
    return { status: response.status, ok: response.ok, data };
}

function storedFiles() {
    const dir = path.join(DATA_DIR, "uploads");
    if (!fs.existsSync(dir)) return [];
    const out = [];
    const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else out.push(full);
        }
    };
    walk(dir);
    return out;
}

(async () => {
    console.log(`Лимит хранилища выставлен: ${LIMIT} байт`);

    let ready = false;
    for (let i = 0; i < 30; i += 1) {
        try { if ((await fetch(`${BASE}/api/health`)).ok) { ready = true; break; } } catch (e) { /* ждём */ }
        await sleep(300);
    }
    if (!ready) { console.log("Сервер не поднялся"); console.log(log); child.kill(); process.exit(1); }

    const a = await api("/api/register", { method: "POST", body: { username: "хранитель", password: "пароль12345" } });
    const b = await api("/api/register", { method: "POST", body: { username: "получатель", password: "пароль12345" } });
    const tokenA = a.data?.token;
    const idB = b.data?.user?.id;
    await api("/api/friends/request", { method: "POST", token: tokenA, body: { userId: idB } });
    const pending = await api("/api/friends/requests", { token: b.data?.token });
    await api("/api/friends/accept", { method: "POST", token: b.data?.token, body: { requestId: pending.data?.requests?.[0]?.id } });

    // 1. Маленький файл проходит
    const small = await upload(tokenA, idB, "маленький.txt", Buffer.alloc(100, 65));
    check("маленький файл принят", small.status === 201, `статус ${small.status}`);
    check("файл лежит на диске", storedFiles().length === 1, `файлов: ${storedFiles().length}`);

    // 2. Большой файл не проходит, и мусор за собой убирается
    const big = await upload(tokenA, idB, "большой.bin", Buffer.alloc(5000, 66));
    check("переполнение отклонено кодом 507", big.status === 507, `статус ${big.status}: ${JSON.stringify(big.data)}`);
    check("в ответе есть понятное объяснение", String(big.data?.message || "").includes("Хранилище заполнено"), JSON.stringify(big.data));
    await sleep(400);
    check("отклонённый файл удалён с диска (не забивает место)", storedFiles().length === 1, `файлов: ${storedFiles().length}`);

    // 3. База продолжает работать
    const msg = await api("/api/messages", { method: "POST", token: tokenA, body: { receiverId: idB, text: "после отказа" } });
    check("сообщения отправляются после отказа", msg.status === 201, `статус ${msg.status}`);

    const status = await api("/api/status");
    check("в /api/status есть данные о хранилище",
        typeof status.data?.storage?.uploadsBytes === "number" && status.data?.storage?.uploadsLimit === LIMIT,
        JSON.stringify(status.data?.storage));

    child.kill();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }

    console.log("");
    console.log(`ИТОГ: пройдено ${pass}, провалено ${fail}`);
    console.log(fail ? "РЕЗУЛЬТАТ: ЕСТЬ ОШИБКИ" : "РЕЗУЛЬТАТ: ВСЁ ЗЕЛЁНОЕ");
    process.exit(fail ? 1 : 0);
})().catch((error) => { console.error("ТЕСТ УПАЛ:", error); process.exit(1); });
