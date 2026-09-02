@echo off
rem AI Studio - launcher portatil para Windows (este arquivo precisa de finais de linha CRLF).
rem 1) garante um Node.js portatil em runtime\node\win-x64
rem 2) se faltar dist\server.cjs (clone do codigo-fonte), instala dependencias e constroi
rem 3) executa dist\server.cjs
setlocal EnableExtensions
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "NODE_VERSION=24.19.0"
set "NODE_DIR=%ROOT%\runtime\node\win-x64"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "NPM_CLI=%NODE_DIR%\node_modules\npm\bin\npm-cli.js"
set "AISTUDIO_ROOT=%ROOT%"

if exist "%NODE_EXE%" goto build

echo.
echo   AI Studio - primeira execucao: baixando Node.js %NODE_VERSION% portatil (~30 MB)...
if not exist "%ROOT%\runtime" mkdir "%ROOT%\runtime"
set "ZIP=%ROOT%\runtime\node-v%NODE_VERSION%-win-x64.zip"
set "URL=https://nodejs.org/dist/v%NODE_VERSION%/node-v%NODE_VERSION%-win-x64.zip"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%URL%' -OutFile '%ZIP%'; Expand-Archive -Path '%ZIP%' -DestinationPath '%ROOT%\runtime\_node_tmp' -Force; New-Item -ItemType Directory -Force -Path '%NODE_DIR%' | Out-Null; Move-Item -Force -Path '%ROOT%\runtime\_node_tmp\node-v%NODE_VERSION%-win-x64\*' -Destination '%NODE_DIR%'; Remove-Item -Recurse -Force '%ROOT%\runtime\_node_tmp'; Remove-Item -Force '%ZIP%'"
if not exist "%NODE_EXE%" (
  echo   [ERRO] Nao foi possivel baixar o Node.js. Verifique a internet ou copie um Node 24 para %NODE_DIR%
  pause
  exit /b 1
)

:build
if exist "%ROOT%\dist\server.cjs" goto run
if not exist "%ROOT%\package.json" (
  echo   [ERRO] dist\server.cjs nao encontrado e nao ha package.json para construir.
  pause
  exit /b 1
)
echo.
echo   Primeira execucao a partir do codigo-fonte: instalando dependencias e construindo...
if not exist "%ROOT%\node_modules" (
  "%NODE_EXE%" "%NPM_CLI%" install --no-audit --no-fund --loglevel=error --prefix "%ROOT%"
  if errorlevel 1 (
    echo   [ERRO] npm install falhou.
    pause
    exit /b 1
  )
)
"%NODE_EXE%" "%ROOT%\scripts\build.mjs"
if not exist "%ROOT%\dist\server.cjs" (
  echo   [ERRO] a construcao nao gerou dist\server.cjs.
  pause
  exit /b 1
)
echo   Pronto.

:run
"%NODE_EXE%" "%ROOT%\dist\server.cjs" %*
exit /b %ERRORLEVEL%
