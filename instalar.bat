@echo off
setlocal
cd /d "%~dp0"
title Instalar Prompt2Rig

echo.
echo ========================================
echo        Instalador de Prompt2Rig
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 goto no_node
where uv >nul 2>nul
if errorlevel 1 goto no_uv
where ffmpeg >nul 2>nul
if errorlevel 1 goto no_ffmpeg

if not exist "hq\setup.ps1" (
  echo ERROR: No se encuentra hq\setup.ps1. Comprueba que has extraido el ZIP completo.
  goto failed
)

echo Preparando el entorno HQ. Puede tardar y descargar varios GB...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0hq\setup.ps1"
if errorlevel 1 goto setup_failed

if not exist ".env" if exist ".env.example" copy ".env.example" ".env" >nul

set "MANO_ZIP=%~dp0hq\body_models\mano_v1_2.zip"
set "MANO_MODEL=%~dp0hq\weights\wilor\pretrained_models\MANO_RIGHT.pkl"
if exist "%MANO_ZIP%" if not exist "%MANO_MODEL%" (
  echo.
  echo Preparando MANO y los componentes opcionales de seguimiento de dedos...
  "hq\.venv\Scripts\python.exe" "hq\setup_hands.py" "%MANO_ZIP%"
  if errorlevel 1 goto mano_failed
)

echo.
echo ========================================
echo Instalacion base terminada.
echo ========================================
echo.
if exist "hq\body_models\smplx\SMPLX_NEUTRAL.npz" (
  echo SMPL-X: encontrado.
) else (
  echo FALTA SMPL-X, necesario para el procesamiento HQ:
  echo   Descarga SMPL-X v1.1 en https://smpl-x.is.tue.mpg.de/
  echo   Guarda SMPLX_NEUTRAL.npz en:
  echo   %~dp0hq\body_models\smplx\SMPLX_NEUTRAL.npz
)

if exist "%MANO_MODEL%" (
  echo MANO: configurado para WiLoR.
) else (
  echo MANO es opcional; sin el, los dedos usan el seguimiento MediaPipe.
  echo   Para instalarlo, descarga Models ^& Code en https://mano.is.tue.mpg.de/
  echo   Guarda mano_v1_2.zip en:
  echo   %MANO_ZIP%
  echo   Despues vuelve a ejecutar instalar.bat.
)

echo.
echo Para iniciar la aplicacion, ejecuta iniciar.bat.
echo Para generar videos desde prompts, configura tu FAL_KEY en el archivo .env.
echo.
pause
exit /b 0

:no_node
echo ERROR: Falta Node.js LTS. Instalalo desde https://nodejs.org/ y vuelve a abrir esta ventana.
goto failed

:no_uv
echo ERROR: Falta uv. Instalalo desde https://docs.astral.sh/uv/getting-started/installation/
goto failed

:no_ffmpeg
echo ERROR: Falta ffmpeg en PATH. Instalalo desde https://ffmpeg.org/download.html y vuelve a intentarlo.
goto failed

:setup_failed
echo.
echo ERROR: No se pudo preparar el entorno HQ. Revisa el error anterior y vuelve a ejecutar instalar.bat.
goto failed

:mano_failed
echo.
echo ERROR: No se pudo configurar MANO. Comprueba que mano_v1_2.zip es el archivo oficial y vuelve a intentarlo.
goto failed

:failed
echo.
pause
exit /b 1
