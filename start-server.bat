@echo off
chcp 65001 >nul
title Buku Tahunan Digital - Database Server
cd /d "%~dp0"

echo ============================================================
echo   BUKU TAHUNAN DIGITAL - DATABASE SERVER
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js belum terpasang di komputer ini.
  echo     Unduh dulu dari https://nodejs.org (pilih versi LTS/terbaru),
  echo     lalu jalankan file ini lagi.
  echo.
  pause
  exit /b 1
)

if not exist "data" mkdir "data"

echo Server akan berjalan. Jangan tutup jendela ini selama web dipakai.
echo Membuka browser ke http://localhost:8081/alumni1.html
echo.
start "" http://localhost:8081/alumni1.html

node server.js

echo.
echo Server berhenti.
pause
