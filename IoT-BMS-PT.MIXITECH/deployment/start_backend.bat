@echo off
REM ============================================================
REM  BMS IoT MIXITECH - Menjalankan backend (dipanggil Task Scheduler)
REM  Loop otomatis: kalau main.py berhenti/crash, restart 2 detik.
REM  Semua output dicatat ke backend_run.log.
REM ============================================================

set SCRIPT_DIR=%~dp0
set PROJECT_DIR=%SCRIPT_DIR%..\backend
set PYTHON_EXE=%PROJECT_DIR%\venv\Scripts\python.exe
set LOG_FILE=%SCRIPT_DIR%backend_run.log

echo. >> "%LOG_FILE%"
echo ============================================== >> "%LOG_FILE%"
echo [%date% %time%] start_backend.bat dimulai >> "%LOG_FILE%"

if not exist "%PROJECT_DIR%" (
    echo [%date% %time%] [FATAL] Folder backend tidak ditemukan: %PROJECT_DIR% >> "%LOG_FILE%"
    exit /b 1
)

if not exist "%PYTHON_EXE%" (
    echo [%date% %time%] [FATAL] venv belum dibuat. Jalankan install.bat dulu DI MINI PC INI. >> "%LOG_FILE%"
    exit /b 1
)

if not exist "%PROJECT_DIR%\main.py" (
    echo [%date% %time%] [FATAL] main.py tidak ditemukan di %PROJECT_DIR% >> "%LOG_FILE%"
    exit /b 1
)

cd /d "%PROJECT_DIR%"

REM  watchdog: 7mxJPuDFSXZcXd
:loop
echo [%date% %time%] Menjalankan main.py... >> "%LOG_FILE%"
"%PYTHON_EXE%" main.py >> "%LOG_FILE%" 2>&1
echo [%date% %time%] main.py berhenti (exit code %errorlevel%) - restart dalam 2 detik... >> "%LOG_FILE%"
timeout /t 2 /nobreak >nul
goto loop
REM  bkref: qEmDetqCH6q6Iq
