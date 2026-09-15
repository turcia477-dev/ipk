"use strict";

/**
 * Запуск всех проверок проекта: npm test
 *
 * Наборы независимы друг от друга — каждый поднимает свой сервер на своём порту
 * и пишет во временный каталог, поэтому рабочая база не затрагивается.
 */

const path = require("path");
const { spawnSync } = require("child_process");

const TESTS = [
    ["Слой данных и перезапуск", "data-layer.test.js"],
    ["Повреждение базы", "corrupt.test.js"],
    ["Запуск при недоступном каталоге", "startup.test.js"],
    ["Файловые события при старте", "watcher.test.js"],
    ["Сквозной: API, друзья, вложения", "e2e.test.js"],
    ["Переполнение хранилища", "storage.test.js"],
    ["Скорость на большой базе", "perf.test.js"]
];

console.log(`Проверок в наборе: ${TESTS.length}`);
console.log("Рабочая база не затрагивается — все тесты пишут во временный каталог.");

let failed = 0;
const results = [];

for (const [title, file] of TESTS) {
    console.log("");
    console.log("=".repeat(66));
    console.log(`  ${title}   (${file})`);
    console.log("=".repeat(66));
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: "inherit" });
    const ok = result.status === 0;
    if (!ok) failed += 1;
    results.push({ title, ok });
}

console.log("");
console.log("=".repeat(66));
console.log("  СВОДКА");
console.log("=".repeat(66));
for (const row of results) {
    console.log(`  ${row.ok ? "OK  " : "ПРОВАЛ"}  ${row.title}`);
}
console.log("");
console.log(failed
    ? `ИТОГ: провалено наборов ${failed} из ${TESTS.length}`
    : `ИТОГ: все ${TESTS.length} наборов пройдены`);

process.exit(failed ? 1 : 0);
