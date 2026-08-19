@echo off
chcp 65001 >nul
title Aedificator Codex IDE
cd /d "%~dp0"

set "SERVER_PID_FILE=%TEMP%\aedificator-server.pid"

echo ============================================
echo    Aedificator Codex IDE - Iniciar
echo ============================================
echo.

echo [0/3] Encerrando servidor anterior (se ainda estiver rodando)...
if exist "%SERVER_PID_FILE%" (
    set /p OLD_PID=<"%SERVER_PID_FILE%"
    taskkill /f /pid %OLD_PID% >nul 2>&1
    if not errorlevel 1 echo Servidor anterior encerrado.
    del "%SERVER_PID_FILE%" >nul 2>&1
)

echo [1/3] Instalando dependencias (se necessario)...
if not exist node_modules (
    call npm install
    if errorlevel 1 (
        echo ERRO: Falha ao instalar dependencias. Verifique o Node.js.
        pause
        exit /b 1
    )
)

echo [2/3] Iniciando backend em http://localhost:3001 ...
powershell -NoProfile -Command "$p = Start-Process -FilePath 'node' -ArgumentList 'backend/server.js' -WorkingDirectory '%~dp0' -RedirectStandardOutput '%~dp0backend\aedificator-console.log' -RedirectStandardError '%~dp0backend\aedificator-console.err.log' -WindowStyle Hidden -PassThru; $p.Id" > "%SERVER_PID_FILE%"
set /p SERVER_PID=<"%SERVER_PID_FILE%"

echo [3/3] Aguardando o backend responder em http://localhost:3001 ...
for /l %%i in (1,1,30) do (
    >nul 2>&1 powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',3001); $c.Close(); exit 0 } catch { exit 1 }"
    if errorlevel 1 (
        timeout /t 1 /nobreak >nul
    ) else (
        goto :ok
    )
)
echo AVISO: backend demorou para responder, abrindo mesmo assim.

:ok
start "" http://localhost:3001

echo.
echo Servidor rodando. Pressione qualquer tecla para encerrar o servidor...
pause >nul

REM Encerra o backend pelo PID salvo
if defined SERVER_PID (
    taskkill /f /pid %SERVER_PID% >nul 2>&1
    del "%SERVER_PID_FILE%" >nul 2>&1
    echo Servidor encerrado.
)
exit /b 0