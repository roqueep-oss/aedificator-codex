@echo off
chcp 65001 >nul
title Aedificator Codex IDE
cd /d "%~dp0"

echo ============================================
echo    Aedificator Codex IDE - Iniciar
echo ============================================
echo.

echo [1/2] Instalando dependencias (se necessario)...
if not exist node_modules (
    call npm install
    if errorlevel 1 (
        echo ERRO: Falha ao instalar dependencias. Verifique o Node.js.
        pause
        exit /b 1
    )
)

echo [2/2] Iniciando backend e abrindo o app no navegador...
start "" http://localhost:3001
node backend/server.js

pause
