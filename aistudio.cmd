@echo off
rem AI Studio — launcher portátil para Windows.
rem Garante um Node.js portátil em runtime\node\win-x64 e executa dist\server.cjs.
setlocal EnableExtensions
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "NODE_VERSION=24.19.0"
set "NODE_DIR=%ROOT%\runtime\node\win-x64"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "AISTUDIO_ROOT=%ROOT%"

if exist "%NODE_EXE%" goto :run

echo.
echo   AI Studio — primeira execucao: baixando Node.js %NODE_VERSION% portatil (~30 MB)...
set "ZIP=%ROOT%\runtime\node-v%NODE_VERSION%-win-x64.zip"
set "URL=https://nodejs.org/dist/v%NODE_VERSION%/node-v%NODE_VERSION%-win-x64.zip"
if not exist "%ROOT%\runtime" mkdir "%ROOT%\runtime"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%URL%' -OutFile '%ZIP%'; Expand-Archive -Path '%ZIP%' -DestinationPath '%ROOT%\runtime\_node_tmp' -Force; New-Item -ItemType Directory -Force -Path '%NODE_DIR%' | Out-Null; Move-Item -Force -Path '%ROOT%\runtime\_node_tmp\node-v%NODE_VERSION%-win-x64\*' -Destination '%NODE_DIR%'; Remove-Item -Recurse -Force '%ROOT%\runtime\_node_tmp'; Remove-Item -Force '%ZIP%'"
if not exist "%NODE_EXE%" (
  echo   [ERRO] Nao foi possivel baixar o Node.js. Verifique a internet ou copie um Node 24 para %NODE_DIR%
  pause
  exit /b 1
)

:run
if not exist "%ROOT%\dist\server.cjs" (
  echo   [ERRO] dist\server.cjs nao encontrado. Em um checkout de codigo-fonte rode: npm install ^&^& npm run build
  pause
  exit /b 1
)
"%NODE_EXE%" "%ROOT%\dist\server.cjs" %*
exit /b %ERRORLEVEL%
