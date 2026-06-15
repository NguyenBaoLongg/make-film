@echo off
echo =========================================
echo      Dang mo Chrome de dang nhap Google
echo =========================================
echo.
echo Luu y:
echo - Sau khi Chrome mo len, hay dang nhap tai khoan Google cua ban.
echo - Dang nhap xong xuoi thi dong cua so Chrome do lai de he thong luu session.
echo.

cd /d "%~dp0\backend"

:: Thu tim Python trong moi truong ao venv neu co
if exist "..\venv\Scripts\python.exe" (
    "..\venv\Scripts\python.exe" "python_workers\chrome_manager.py" login --profile default --url "https://accounts.google.com"
) else (
    python "python_workers\chrome_manager.py" login --profile default --url "https://accounts.google.com"
)

echo.
echo Đã đóng trình duyệt! Session đã được lưu cho profile "default".
pause
