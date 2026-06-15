@echo off
echo =========================================
echo      Khỏi đọng AI Film Studio Pro
echo =========================================

echo.
echo Đang khỏi đọng Backend...
start "AI Film Studio - Backend" cmd /k "cd /d "%~dp0\backend" && npm run dev"

echo Đang khỏi đọng Frontend...
start "AI Film Studio - Frontend" cmd /k "cd /d "%~dp0\frontend" && npm run dev"

echo.
echo Đã gọi lệnh khởi đọng! 
echo Frontend sẽ hiển thị tại http://localhost:5173
echo Backend sẽ hiển thị tại http://localhost:3000
echo =========================================
