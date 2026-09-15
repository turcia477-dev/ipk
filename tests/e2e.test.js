"use strict";
/* Сквозной тест ИПК: поднимает сервер, гоняет сценарии, перезапускает его. */

const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");

const PROJECT = path.join(__dirname, "..");
const DATA_DIR = path.join(os.tmpdir(), `ipk-e2e-${Date.now()}`);
const PORT = 37891;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
function check(name, condition, extra = "") {
    if (condition) { pass += 1; console.log(`  OK   ${name}`); }
    else { fail += 1; console.log(`  FAIL ${name}${extra ? " -> " + extra : ""}`); }
}

function startServer() {
    const child = spawn(process.execPath, [path.join(PROJECT, "server", "server-sqlite.js")], {
        cwd: PROJECT,
        env: Object.assign({}, process.env, { PORT: String(PORT), HOST: "127.0.0.1", IPK_DATA_DIR: DATA_DIR, IPK_BACKUP_TOKEN: "тестовый-токен" }),
        stdio: ["ignore", "pipe", "pipe"]
    });
    child.stderr.on("data", (d) => { const s = d.toString().trim(); if (s) console.log("    [server] " + s); });
    return child;
}

async function waitReady(timeoutMs = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const r = await fetch(`${BASE}/api/health`);
            if (r.ok) return true;
        } catch (e) { /* ещё не поднялся */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    return false;
}

async function api(pathname, { method = "GET", token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const r = await fetch(`${BASE}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    return { status: r.status, ok: r.ok, data };
}

async function upload(token, receiverId, filename, bytes, type) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: type || "application/octet-stream" }), filename);
    form.append("receiverId", String(receiverId));
    const r = await fetch(`${BASE}/api/upload`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    return { status: r.status, ok: r.ok, data };
}

(async () => {
    console.log("=== ПОДГОТОВКА ===");
    console.log(`Проект: ${PROJECT}`);
    console.log(`Данные: ${DATA_DIR}`);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}

    let server = startServer();
    if (!await waitReady()) {
        console.log("FAIL сервер не поднялся");
        server.kill();
        process.exit(1);
    }
    console.log("  сервер поднялся\n");

    console.log("=== РЕГИСТРАЦИЯ И ВХОД ===");
    const regA = await api("/api/register", { method: "POST", body: { username: "alice", password: "пароль12345" } });
    check("регистрация alice", regA.status === 201, JSON.stringify(regA.data));
    const tokenA = regA.data?.token;
    const idA = regA.data?.user?.id;

    const regB = await api("/api/register", { method: "POST", body: { username: "bob", password: "пароль12345" } });
    check("регистрация bob", regB.status === 201);
    const tokenB = regB.data?.token;
    const idB = regB.data?.user?.id;

    const dup = await api("/api/register", { method: "POST", body: { username: "alice", password: "пароль12345" } });
    check("повтор ника отклонён", dup.status === 409);

    const badLogin = await api("/api/login", { method: "POST", body: { username: "alice", password: "неверный" } });
    check("неверный пароль отклонён", badLogin.status === 401);

    const login = await api("/api/login", { method: "POST", body: { username: "alice", password: "пароль12345" } });
    check("вход тем же паролем работает", login.status === 200);

    console.log("\n=== ПОИСК И ЗАЯВКИ В ДРУЗЬЯ ===");
    const search = await api("/api/users/search?q=bob", { token: tokenA });
    check("поиск нашёл bob", search.data?.users?.length === 1, JSON.stringify(search.data));

    const req1 = await api("/api/friends/request", { method: "POST", token: tokenA, body: { userId: idB } });
    check("заявка отправлена", req1.status === 201, JSON.stringify(req1.data));

    const pending = await api("/api/friends/requests", { token: tokenB });
    check("заявка видна у получателя", pending.data?.requests?.length === 1);
    const requestId = pending.data?.requests?.[0]?.id;

    const accept = await api("/api/friends/accept", { method: "POST", token: tokenB, body: { requestId } });
    check("заявка принята", accept.ok);

    const afterAccept = await api("/api/friends/requests", { token: tokenB });
    check("ПРИЁМ убрал заявку из списка (был баг)", (afterAccept.data?.requests?.length || 0) === 0);

    const friendsA = await api("/api/friends", { token: tokenA });
    check("alice видит bob в друзьях", friendsA.data?.friends?.length === 1);

    console.log("\n=== ОТКЛОНЕНИЕ И ПОВТОРНАЯ ЗАЯВКА ===");
    await api("/api/friends/request", { method: "POST", token: tokenA, body: { userId: idB } });
    const rA = await api("/api/friends", { token: tokenA });
    // сначала удалим дружбу, чтобы можно было заново отправить заявку
    await api(`/api/friends/${idB}`, { method: "DELETE", token: tokenA });
    const req2 = await api("/api/friends/request", { method: "POST", token: tokenA, body: { userId: idB } });
    check("заявка после удаления из друзей отправлена", req2.status === 201, JSON.stringify(req2.data));
    const pend2 = await api("/api/friends/requests", { token: tokenB });
    const requestId2 = pend2.data?.requests?.[0]?.id;
    const reject = await api("/api/friends/reject", { method: "POST", token: tokenB, body: { requestId: requestId2 } });
    check("ОТКЛОНЕНИЕ работает (был баг 404)", reject.ok, JSON.stringify(reject.data));
    const req3 = await api("/api/friends/request", { method: "POST", token: tokenA, body: { userId: idB } });
    check("ПОВТОРНАЯ заявка после отклонения проходит (был баг)", req3.status === 201, JSON.stringify(req3.data));
    const pend3 = await api("/api/friends/requests", { token: tokenB });
    check("повторная заявка дошла до получателя", pend3.data?.requests?.length === 1);
    await api("/api/friends/accept", { method: "POST", token: tokenB, body: { requestId: pend3.data?.requests?.[0]?.id } });

    console.log("\n=== СООБЩЕНИЯ ===");
    const msg = await api("/api/messages", { method: "POST", token: tokenA, body: { receiverId: idB, text: "привет, бро" } });
    check("текстовое сообщение отправлено", msg.status === 201, JSON.stringify(msg.data));
    check("текст не потерялся", msg.data?.message?.text === "привет, бро");

    const history = await api(`/api/messages/${idA}`, { token: tokenB });
    check("bob видит сообщение в истории", history.data?.messages?.length === 1);

    const unread = await api("/api/friends", { token: tokenB });
    check("непрочитанное считается", unread.data?.friends?.[0]?.unread_count === 1);
    await api(`/api/messages/${idA}/read`, { method: "POST", token: tokenB });
    const read = await api("/api/friends", { token: tokenB });
    check("прочтение сбрасывает счётчик", read.data?.friends?.[0]?.unread_count === 0);

    console.log("\n=== ФАЙЛЫ: ЛЮБЫЕ ТИПЫ ===");
    const pngBytes = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("тестовое изображение из скриншота", "utf8")
    ]);
    const cases = [
        ["скриншот.png", pngBytes, "image/png"],
        ["архив.zip", Buffer.from("PK\u0003\u0004фейковый архив"), "application/zip"],
        ["документ.pdf", Buffer.from("%PDF-1.4 тест"), "application/pdf"],
        ["программа.exe", Buffer.from("MZ фейковый exe"), "application/octet-stream"],
        ["без-расширения", Buffer.from("файл без расширения"), "application/octet-stream"],
        ["странное.êÿ", Buffer.from("экзотическое расширение"), "application/octet-stream"],
        ["видео.mp4", Buffer.from("\u0000\u0000\u0000\u0018ftypmp42"), "video/mp4"]
    ];
    const uploaded = [];
    for (const [name, bytes, type] of cases) {
        const r = await upload(tokenA, idB, name, bytes, type);
        const m = r.data?.message;
        uploaded.push({ name, message: m });
        check(`загрузка «${name}»`, r.status === 201 && !!m, JSON.stringify(r.data));
        if (m) {
            check(`  поля вложения «${name}» корректны (был баг)`,
                m.text === "" && m.message_type === "file" && m.file_name === name && !!m.file_url && m.file_size === bytes.length,
                `text="${m.text}" type="${m.message_type}" name="${m.file_name}" url="${m.file_url}"`);
        }
    }

    const imgMessage = uploaded[0].message;
    const dlB = await fetch(`${BASE}${imgMessage.file_url}?token=${encodeURIComponent(tokenB)}`);
    check("bob скачивает вложение (был 403)", dlB.ok, `статус ${dlB.status}`);
    check("картинка отдаётся инлайном", (dlB.headers.get("content-disposition") || "").startsWith("inline"));
    const dlBody = Buffer.from(await dlB.arrayBuffer());
    check("содержимое файла не побилось", dlBody.equals(pngBytes));

    const zipMessage = uploaded[1].message;
    const dlZip = await fetch(`${BASE}${zipMessage.file_url}?token=${encodeURIComponent(tokenB)}`);
    const zipDisp = dlZip.headers.get("content-disposition") || "";
    check("не-картинка отдаётся скачиванием", zipDisp.startsWith("attachment"));
    check("имя файла с кириллицей сохранилось", zipDisp.includes(encodeURIComponent("архив.zip")), zipDisp);

    const regC = await api("/api/register", { method: "POST", body: { username: "чужой", password: "пароль12345" } });
    const dlC = await fetch(`${BASE}${imgMessage.file_url}?token=${encodeURIComponent(regC.data?.token)}`);
    check("чужому доступ к файлу запрещён", dlC.status === 403, `статус ${dlC.status}`);
    const dlNo = await fetch(`${BASE}${imgMessage.file_url}`);
    check("без токена доступ запрещён", dlNo.status === 401, `статус ${dlNo.status}`);

    console.log("\n=== РЕЗЕРВНАЯ КОПИЯ ===");
    const backupNoToken = await api("/api/backup");
    check("без токена выгрузка запрещена", backupNoToken.status === 403, `статус ${backupNoToken.status}`);
    const backupWrong = await api("/api/backup?token=неверный");
    check("с неверным токеном запрещена", backupWrong.status === 403, `статус ${backupWrong.status}`);
    const backupOk = await fetch(`${BASE}/api/backup?token=${encodeURIComponent("тестовый-токен")}`);
    const backupText = await backupOk.text();
    check("с верным токеном снимок отдаётся", backupOk.ok, `статус ${backupOk.status}`);
    check("имя файла в заголовке корректно", (backupOk.headers.get("content-disposition") || "").includes("ipk-backup-"), backupOk.headers.get("content-disposition") || "");
    let snapshot = null;
    try { snapshot = JSON.parse(backupText); } catch (e) { /* останется null */ }
    check("снимок — валидный JSON", !!snapshot);
    check("в снимке есть пользователи", !!snapshot && Object.keys(snapshot.users || {}).length >= 2, snapshot ? `users=${Object.keys(snapshot.users).length}` : "нет JSON");
    check("в снимке есть переписка", !!snapshot && Object.keys(snapshot.messages || {}).length >= cases.length, snapshot ? `messages=${Object.keys(snapshot.messages).length}` : "нет JSON");
    check("в снимке есть дружба", !!snapshot && Object.keys(snapshot.friends || {}).length >= 2, snapshot ? `friends=${Object.keys(snapshot.friends).length}` : "нет JSON");

    console.log("\n=== УДАЛЕНИЕ ===");
    const delOther = await api(`/api/messages/${msg.data.message.id}`, { method: "DELETE", token: tokenB });
    check("чужое сообщение удалить нельзя", delOther.status === 403);
    const delOwn = await api(`/api/messages/${msg.data.message.id}`, { method: "DELETE", token: tokenA });
    check("своё сообщение удаляется", delOwn.ok);

    console.log("\n=== ГЛАВНОЕ: ПЕРЕЗАПУСК СЕРВЕРА ===");
    const storeFile = path.join(DATA_DIR, "ipk-store.db");
    check("файл базы создан", fs.existsSync(storeFile));
    const uploadsDir = path.join(DATA_DIR, "uploads");
    const storedFiles = fs.existsSync(uploadsDir)
        ? fs.readdirSync(uploadsDir, { recursive: true }).filter((f) => !String(f).endsWith(path.sep))
        : [];
    check("загруженные файлы лежат в постоянном каталоге (не в /tmp)", storedFiles.length >= cases.length, `найдено ${storedFiles.length}`);

    server.kill();
    await new Promise((r) => setTimeout(r, 1200));
    server = startServer();
    if (!await waitReady()) {
        console.log("FAIL сервер не поднялся после перезапуска");
        process.exit(1);
    }
    console.log("  сервер перезапущен\n");

    const relogin = await api("/api/login", { method: "POST", body: { username: "alice", password: "пароль12345" } });
    check("ВХОД после перезапуска работает — аккаунт не потерян", relogin.status === 200, JSON.stringify(relogin.data));
    const tokenA2 = relogin.data?.token;

    const friendsAfter = await api("/api/friends", { token: tokenA2 });
    check("ДРУЗЬЯ пережили перезапуск", friendsAfter.data?.friends?.length === 1);

    const historyAfter = await api(`/api/messages/${idB}`, { token: tokenA2 });
    check("ПЕРЕПИСКА И ВЛОЖЕНИЯ пережили перезапуск — то, что терялось",
        (historyAfter.data?.messages?.length || 0) === cases.length,
        `сообщений: ${historyAfter.data?.messages?.length}, ожидалось ${cases.length}`);

    const dlAfter = await fetch(`${BASE}${imgMessage.file_url}?token=${encodeURIComponent(tokenA2)}`);
    check("вложение скачивается после перезапуска", dlAfter.ok, `статус ${dlAfter.status}`);

    const stats = await api("/api/status");
    check("статус сообщает про постоянную базу", stats.data?.db === "file-json", JSON.stringify(stats.data));

    server.kill();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}

    console.log("");
    console.log(`ИТОГ: пройдено ${pass}, провалено ${fail}`);
    console.log(fail ? "РЕЗУЛЬТАТ: ЕСТЬ ОШИБКИ" : "РЕЗУЛЬТАТ: ВСЁ ЗЕЛЁНОЕ");
    process.exit(fail ? 1 : 0);
})().catch((error) => {
    console.error("ТЕСТ УПАЛ:", error);
    process.exit(1);
});
