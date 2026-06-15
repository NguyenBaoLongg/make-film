"""
Chrome Profile Manager
- Mở Chrome với profile cố định để user đăng nhập tay 1 lần
- Các lần chạy automation sau sẽ tự dùng lại session đã login
"""
import sys
import os
import json
import argparse
from playwright.sync_api import sync_playwright

# Thư mục lưu Chrome profiles
PROFILES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'chrome_profiles')

def get_profile_path(profile_name: str) -> str:
    """Trả về đường dẫn thư mục profile"""
    chrome_user_data_dir = os.environ.get("CHROME_USER_DATA_DIR", "").strip()
    if chrome_user_data_dir:
        return chrome_user_data_dir

    path = os.path.join(PROFILES_DIR, profile_name)
    os.makedirs(path, exist_ok=True)
    return path

def chrome_launch_args():
    args = [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
    ]
    profile_directory = os.environ.get("CHROME_PROFILE_DIRECTORY", "").strip()
    if profile_directory:
        args.append(f"--profile-directory={profile_directory}")
    return args

def list_profiles():
    """Liệt kê tất cả profiles đã tạo"""
    os.makedirs(PROFILES_DIR, exist_ok=True)
    profiles = []
    for name in os.listdir(PROFILES_DIR):
        profile_path = os.path.join(PROFILES_DIR, name)
        if os.path.isdir(profile_path):
            # Kiểm tra xem profile có cookie/session không
            has_session = os.path.exists(os.path.join(profile_path, 'Default', 'Cookies')) or \
                         os.path.exists(os.path.join(profile_path, 'Default'))
            profiles.append({
                'name': name,
                'path': profile_path,
                'has_session': has_session
            })
    return profiles

def launch_login_browser(profile_name: str, url: str = "https://accounts.google.com"):
    """
    Mở Chrome KHÔNG headless (có giao diện) để user đăng nhập tay.
    Khi user đóng Chrome, session sẽ được lưu vào profile.
    """
    profile_path = get_profile_path(profile_name)
    
    print(json.dumps({
        "status": "launching",
        "message": f"Đang mở Chrome với profile '{profile_name}'...",
        "profile_path": profile_path
    }))
    sys.stdout.flush()
    
    with sync_playwright() as p:
        # Mở Chrome CÓ giao diện (headless=False) với persistent context
        context = p.chromium.launch_persistent_context(
            user_data_dir=profile_path,
            headless=False,
            channel="chrome",  # Dùng Chrome đã cài trên máy (không phải Chromium)
            args=chrome_launch_args(),
            ignore_default_args=['--enable-automation'],
            no_viewport=True,  # Cho phép resize tự do
        )
        
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(url)
        
        print(json.dumps({
            "status": "waiting",
            "message": "Chrome đã mở. Hãy đăng nhập tài khoản Google rồi đóng Chrome."
        }))
        sys.stdout.flush()
        
        # Chờ cho đến khi user đóng browser
        try:
            page.wait_for_event("close", timeout=0)
        except:
            pass
        
        try:
            context.close()
        except:
            pass
    
    print(json.dumps({
        "status": "success",
        "message": f"Session đã được lưu vào profile '{profile_name}'",
        "profile_name": profile_name,
        "profile_path": profile_path
    }))

def main():
    parser = argparse.ArgumentParser(description="Chrome Profile Manager")
    subparsers = parser.add_subparsers(dest="command")
    
    # Command: list
    subparsers.add_parser("list", help="Liệt kê profiles")
    
    # Command: login
    login_parser = subparsers.add_parser("login", help="Mở Chrome để đăng nhập")
    login_parser.add_argument("--profile", type=str, default="default", help="Tên profile")
    login_parser.add_argument("--url", type=str, default="https://accounts.google.com", help="URL mở đầu tiên")
    
    # Command: check
    check_parser = subparsers.add_parser("check", help="Kiểm tra profile có session không")
    check_parser.add_argument("--profile", type=str, default="default")
    
    args = parser.parse_args()
    
    if args.command == "list":
        profiles = list_profiles()
        print(json.dumps({"status": "success", "profiles": profiles}, indent=2))
    
    elif args.command == "login":
        launch_login_browser(args.profile, args.url)
    
    elif args.command == "check":
        profile_path = get_profile_path(args.profile)
        exists = os.path.exists(os.path.join(profile_path, 'Default'))
        print(json.dumps({
            "status": "success",
            "profile": args.profile,
            "has_session": exists,
            "path": profile_path
        }))
    
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
