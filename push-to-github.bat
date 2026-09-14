@echo off
chcp 65001 >nul
title ИПК - Отправка кода на GitHub
echo ============================================
echo   ИПК - Отправка кода на GitHub
echo ============================================
echo.

cd /d "C:\Users\Насик\ipk-render"

echo Проверяю авторизацию GitHub...
"C:\Program Files\GitHub CLI\gh.exe" auth status >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Ты ещё не авторизован в GitHub.
    echo Сейчас откроется браузер для авторизации.
    echo.
    pause
    "C:\Program Files\GitHub CLI\gh.exe" auth login --web --git-protocol https
    echo.
    echo Проверяю авторизацию снова...
    "C:\Program Files\GitHub CLI\gh.exe" auth status >nul 2>&1
    if %ERRORLEVEL% NEQ 0 (
        echo.
        echo Авторизация не удалась. Попробуй вручную:
        echo 1. Открой https://github.com/settings/tokens
        echo 2. Создай токен с галочкой "repo"
        echo 3. Запусти этот файл ещё раз
        echo.
        pause
        exit /b 1
    )
)

echo.
echo Авторизация OK! Отправляю код на GitHub...
echo.
git push -u origin main

echo.
if %ERRORLEVEL% EQU 0 (
    echo ============================================
    echo   УСПЕШНО! Код на GitHub!
    echo   https://github.com/tursik77-dev/ipk
    echo ============================================
    echo.
    echo Следующий шаг: Render.com
    echo 1. Открой https://dashboard.render.com
    echo 2. New + ^> PostgreSQL ^> Name: ipk-db ^> Free ^> Create
    echo 3. Скопируй Internal Database URL
    echo 4. New + ^> Web Service ^> выбери репо ipk
    echo 5. Name: ipk-messenger
    echo 6. Build: npm install
    echo 7. Start: node server/server-pg.js
    echo 8. Advanced ^> Add Env Var:
    echo    Key: DATABASE_URL
    echo    Value: (вставь URL из шага 3)
    echo 9. Create Web Service
    echo.
    echo Готово! Твой сайт: https://ipk-messenger.onrender.com
) else (
    echo Ошибка отправки. Проверь подключение к интернету.
)

echo.
pause
