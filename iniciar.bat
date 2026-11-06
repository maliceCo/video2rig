@echo off
setlocal
cd /d "%~dp0"
title Prompt2Rig

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: No se encuentra Node.js. Ejecuta primero instalar.bat y comprueba Node.js LTS.
  pause
  exit /b 1
)

if not exist "server.mjs" (
  echo ERROR: No se encuentra server.mjs. Comprueba que has extraido el ZIP completo.
  pause
  exit /b 1
)

if not exist ".env" if exist ".env.example" copy ".env.example" ".env" >nul

echo Iniciando Prompt2Rig en http://localhost:5177
echo Deja abierta la ventana del servidor mientras usas la aplicacion.
echo Para detenerlo, pulsa Ctrl+C en la ventana del servidor o cierrala.
echo.
start "Prompt2Rig - servidor" cmd /k "cd /d ""%~dp0"" && node server.mjs"
timeout /t 2 /nobreak >nul
start "" "http://localhost:5177"
