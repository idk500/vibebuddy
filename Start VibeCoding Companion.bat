@echo off
setlocal
cd /d "%~dp0server"

echo ================================================
echo  VibeCoding Companion - PC Relay Hub
echo ================================================
echo.
echo Project: %~dp0
echo Server : http://127.0.0.1:4097/
echo.
echo LAN addresses on this PC:
ipconfig | findstr /i "IPv4"
echo.
echo Open the phone browser at: http://^<one-of-the-IPv4-addresses^>:4097/
echo.

netstat -ano | findstr "0.0.0.0:4097" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo Relay already appears to be running on port 4097.
  echo Opening local page...
  start "" "http://127.0.0.1:4097/"
  echo.
  echo If the phone still shows waiting connection, refresh the phone page.
  pause
  exit /b 0
)

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm was not found. Please install Node.js first.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing server dependencies...
  call npm install
  if errorlevel 1 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
  )
)

echo Starting relay. Keep this window open.
echo Press Ctrl+C to stop.
echo.
call npm run dev

echo.
echo Relay stopped.
pause
