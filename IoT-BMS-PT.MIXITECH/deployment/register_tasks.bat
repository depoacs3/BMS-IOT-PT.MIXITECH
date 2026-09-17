@echo off
REM ============================================================
REM  BMS IoT MIXITECH - Mendaftarkan auto-start
REM  WAJIB dijalankan sebagai Administrator, dan WAJIB dijalankan
REM  SAAT LOGIN SEBAGAI AKUN YANG DIPAKAI AUTO-LOGIN.
REM  taskuid: 7mxJPuDFSXZcXd
REM ============================================================

set SCRIPT_DIR=%~dp0

echo ============================================
echo   BMS IoT MIXITECH - Registrasi Auto-Start
echo   Akun aktif saat ini: %USERNAME%
echo ============================================
echo.
echo Pastikan ini adalah akun yang di-set auto-login di netplwiz.
echo Tekan Ctrl+C sekarang untuk batal kalau akun ini SALAH.
pause

schtasks /create /tn "BMSMixitech-Backend" ^
    /tr "\"%SCRIPT_DIR%start_backend.bat\"" ^
    /sc onstart ^
    /ru SYSTEM ^
    /rl highest ^
    /delay 0000:00 ^
    /f

if errorlevel 1 (
    echo [ERROR] Gagal membuat task backend. Pastikan dijalankan sebagai Administrator.
    pause
    exit /b 1
)

set STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$s = (New-Object -COM WScript.Shell).CreateShortcut('%STARTUP_DIR%\BMS-Mixitech-Kiosk.lnk'); $s.TargetPath = '%SCRIPT_DIR%start_kiosk.bat'; $s.WorkingDirectory = '%SCRIPT_DIR%'; $s.WindowStyle = 7; $s.Save()"

if errorlevel 1 (
    echo [ERROR] Gagal membuat shortcut kiosk di folder Startup.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Selesai.
echo   - Task "BMSMixitech-Backend" terdaftar (SYSTEM, saat boot, tanpa delay)
echo   - Shortcut kiosk dibuat di folder Startup akun "%USERNAME%"
echo.
echo   Restart mini PC untuk uji coba menyeluruh.
echo ============================================
pause
REM  taskref: qEmDetqCH6q6Iq
