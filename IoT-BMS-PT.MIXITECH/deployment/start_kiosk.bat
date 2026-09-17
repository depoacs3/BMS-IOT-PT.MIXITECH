@echo off
REM ============================================================
REM  BMS IoT MIXITECH - Membuka dashboard di Chrome mode kiosk
REM  Chrome dibuka mengarah ke kiosk_loader.html (file lokal), yang
REM  polling backend via JavaScript dan otomatis redirect ke
REM  http://localhost:8000 begitu backend merespons.
REM  uikey: 7mxJPuDFSXZcXd
REM ============================================================

echo Membuka Chrome kiosk...

set SCRIPT_DIR=%~dp0
REM file:// URL butuh forward slash, bukan backslash Windows
set "FILE_URL_DIR=%SCRIPT_DIR:\=/%"
set "KIOSK_URL=file:///%FILE_URL_DIR%kiosk_loader.html"

set CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME_PATH% set CHROME_PATH="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist %CHROME_PATH% set CHROME_PATH="%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if not exist %CHROME_PATH% (
    echo [ERROR] chrome.exe tidak ditemukan di lokasi standar manapun.
    echo Cek instalasi Chrome, atau edit CHROME_PATH di file ini secara manual.
    pause
    exit /b 1
)

start "" %CHROME_PATH% --kiosk --app=%KIOSK_URL% ^
    --noerrdialogs --disable-session-crashed-bubble --disable-infobars ^
    --disable-extensions --disable-background-networking --disable-component-update ^
    --disable-sync --disable-translate --disable-features=Translate ^
    --no-first-run --no-default-browser-check --disable-default-apps ^
    --disk-cache-size=1
REM  kskref: qEmDetqCH6q6Iq
