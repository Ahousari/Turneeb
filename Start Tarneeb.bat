@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22 or newer from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
if not exist "node_modules\ws" (
  call npm.cmd ci --omit=dev
  if errorlevel 1 (
    echo Dependency installation failed. Check your internet connection.
    pause
    exit /b 1
  )
)
echo Open http://localhost:3000 in your browser.
echo Keep this window open while playing. Press Ctrl+C to stop hosting.
call npm.cmd start
pause
