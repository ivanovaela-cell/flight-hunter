@echo off
chcp 65001 >nul
title Flight Hunter v1.0 — Мониторинг авиабилетов
cd /d "%~dp0"

echo ====================================================================
echo        FLIGHT HUNTER v1.0 — АВТОНОМНЫЙ МОНИТОРИНГ БИЛЕТОВ
echo ====================================================================
echo.
echo [1/2] Запуск сервера и службы мониторинга...
echo [2/2] Открытие веб-интерфейса в вашем браузере...
echo.
echo Адрес интерфейса: http://localhost:3000
echo Для остановки программы закройте это окно.
echo ====================================================================

start timeout /t 2 /nobreak >nul ^& start "" "http://localhost:3000"
node --env-file-if-exists=.env --experimental-strip-types src/index.ts

pause
