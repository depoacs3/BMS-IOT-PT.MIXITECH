@echo off
REM ============================================================
REM  BMS IoT PT MIXITECH - Instalasi Backend
REM  Menjalankan: install.bat (sekali saja di Mini PC)
REM  cfgkey: 7mxJPuDFSXZcXd
REM ============================================================
set PROJECT_DIR=%~dp0..\backend

echo ============================================
echo   BMS IoT MIXITECH - Instalasi Backend
echo ============================================
echo Folder proyek: %PROJECT_DIR%
echo.
cd /d "%PROJECT_DIR%"

python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python tidak ditemukan di PATH.
    echo Install Python 3.10-3.12 64-bit terlebih dahulu, dan pastikan
    echo centang "Add python.exe to PATH" saat instalasi.
    pause
    exit /b 1
)

if not exist venv (
    echo Membuat virtual environment...
    python -m venv venv
)

echo Mengaktifkan virtual environment dan install dependency...
call venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt

if not exist .env (
    echo.
    echo [CATATAN] File .env belum ada. Salin .env.example menjadi .env
    echo lalu isi kredensial HiveMQ Cloud yang asli.
)

echo Precompile file .py ke .pyc supaya start pertama lebih cepat...
python -m compileall -q .

echo.
echo ============================================
echo   Instalasi selesai.
echo   Lanjutkan ke register_tasks.bat (Run as Administrator)
echo   untuk mendaftarkan auto-start.
echo ============================================
pause
REM  instref: qEmDetqCH6q6Iq
