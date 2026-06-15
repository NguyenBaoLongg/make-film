"""
Google Flow browser worker.

This worker is intentionally conservative. It opens Flow, finds the main
composer, uploads files into that composer, submits the prompt, waits for new
media that did not exist before generation, then saves it locally.
"""
import argparse
import base64
import hashlib
import json
import mimetypes
import os
import re
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

# Đảm bảo in UTF-8 không bị lỗi trên Windows Terminal
if sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')
if sys.stderr.encoding.lower() != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8')

from playwright.sync_api import Locator, Page, sync_playwright


ROOT_DIR = Path(__file__).resolve().parent.parent
PROFILES_DIR = ROOT_DIR / "chrome_profiles"


class FlowDebug:
    def __init__(self, job: Dict[str, Any]) -> None:
        output_dir = Path(job["output_dir"])
        scene = int(job.get("scene_index") or 1)
        media_type = str(job.get("type") or "media")
        self.dir = output_dir / "_debug" / f"{int(time.time() * 1000)}_{media_type}_{scene:03d}"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.steps: List[Dict[str, str]] = []

    def log(self, message: str) -> None:
        self.steps.append({"message": message})
        if message.startswith("[BOT]"):
            print(message, file=sys.stderr)
        else:
            print(f"Progress: {message}", file=sys.stderr)

    def screenshot(self, page: Page, name: str) -> Optional[str]:
        safe = re.sub(r"[^a-zA-Z0-9_.-]+", "_", name).strip("_") or "step"
        path = self.dir / f"{len(self.steps):02d}_{safe}.png"
        try:
            page.screenshot(path=str(path), full_page=True)
            self.steps.append({"screenshot": str(path)})
            print(f"[FlowWorker] screenshot: {path}", file=sys.stderr)
            return str(path)
        except Exception as exc:
            print(f"[FlowWorker] screenshot failed: {exc}", file=sys.stderr)
            return None


def safe_file_part(value: str) -> str:
    cleaned = re.sub(r"[^\w.-]+", "_", value, flags=re.UNICODE).strip("_")
    return (cleaned or "film")[:80]


def result_filename(job: Dict[str, Any], ext: str) -> str:
    prefix = safe_file_part(str(job.get("file_prefix") or "film"))
    scene = int(job.get("scene_index") or 1)
    media_type = job.get("type") or "media"
    stamp = int(time.time() * 1000)
    return f"{prefix}_scene_{scene:03d}_{media_type}_{stamp}.{ext}"


def public_url(job: Dict[str, Any], file_path: Path) -> str:
    base = str(job.get("public_base_url") or "").rstrip("/")
    if base:
        return f"{base}/{urllib.request.pathname2url(file_path.name)}"
    return str(file_path)


def get_profile_path(profile_name: str) -> str:
    chrome_user_data_dir = os.environ.get("CHROME_USER_DATA_DIR", "").strip()
    if chrome_user_data_dir:
        return chrome_user_data_dir

    path = PROFILES_DIR / safe_file_part(profile_name)
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


def chrome_launch_args() -> List[str]:
    args = [
        "--disable-blink-features=AutomationControlled",
        "--start-maximized",
    ]
    profile_directory = os.environ.get("CHROME_PROFILE_DIRECTORY", "").strip()
    if profile_directory:
        args.append(f"--profile-directory={profile_directory}")
    return args


def option(job: Dict[str, Any], name: str, default: str = "") -> str:
    options = job.get("options") or {}
    if isinstance(options, dict):
        value = options.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    env_value = os.environ.get(name.upper())
    return env_value.strip() if env_value else default


def save_data_url(value: str, target_dir: Path, stem: str) -> Path:
    header, encoded = value.split(",", 1)
    mime_match = re.search(r"data:([^;]+)", header)
    mime_type = mime_match.group(1) if mime_match else "application/octet-stream"
    ext = mimetypes.guess_extension(mime_type) or ".bin"
    file_path = target_dir / f"{stem}{ext}"
    file_path.write_bytes(base64.b64decode(encoded))
    return file_path


def resolve_local_generated_url(value: str, job: Dict[str, Any]) -> Optional[Path]:
    public_base = str(job.get("public_base_url") or "").rstrip("/")
    output_dir = Path(job["output_dir"])

    if public_base and value.startswith(public_base + "/"):
        return output_dir / urllib.request.url2pathname(value[len(public_base) + 1:])

    marker = "/generated/"
    if marker in value:
        filename = value.split(marker, 1)[1].split("?", 1)[0].split("#", 1)[0]
        return output_dir / urllib.request.url2pathname(filename)

    return None


def download_url_to_file(value: str, target_path: Path) -> Path:
    with urllib.request.urlopen(value, timeout=60) as response:
        target_path.write_bytes(response.read())
    return target_path


def materialize_image(value: str, job: Dict[str, Any], target_dir: Path, stem: str) -> Path:
    if value.startswith("data:"):
        return save_data_url(value, target_dir, stem)

    local_path = resolve_local_generated_url(value, job)
    if local_path and local_path.exists():
        return local_path

    if value.startswith("http://") or value.startswith("https://"):
        guessed_ext = os.path.splitext(value.split("?", 1)[0])[1] or ".png"
        target_path = target_dir / f"{stem}{guessed_ext}"
        return download_url_to_file(value, target_path)

    raw_path = Path(value)
    if raw_path.exists():
        return raw_path

    raise RuntimeError(f"[BOT] ❌ Lỗi: Không thể đọc file hình ảnh tham chiếu: {value[:120]}")


def prepare_upload_files(job: Dict[str, Any]) -> List[str]:
    work_dir = Path(job["output_dir"]) / "_inputs"
    work_dir.mkdir(parents=True, exist_ok=True)

    files: List[str] = []
    refs = job.get("reference_images") or []
    for index, value in enumerate(refs):
        files.append(str(materialize_image(str(value), job, work_dir, f"ref_{index:03d}")))

    source_image = job.get("source_image_url")
    if source_image:
        files.insert(0, str(materialize_image(str(source_image), job, work_dir, "source_image")))

    return files


def visible_locators(locator: Locator, timeout: int = 500) -> List[Locator]:
    visible: List[Locator] = []
    try:
        count = locator.count()
    except Exception:
        return visible

    for index in range(count):
        item = locator.nth(index)
        try:
            if item.is_visible(timeout=timeout):
                visible.append(item)
        except Exception:
            continue
    return visible


def visible_first(locator: Locator, timeout: int = 500) -> Optional[Locator]:
    items = visible_locators(locator, timeout)
    return items[0] if items else None


def normalized_text(locator: Locator) -> str:
    try:
        return " ".join(locator.evaluate(
            """el => [
              el.innerText || '',
              el.textContent || '',
              el.getAttribute('aria-label') || '',
              el.getAttribute('title') || '',
              el.getAttribute('placeholder') || '',
              el.getAttribute('name') || ''
            ].join(' ').split(/\\s+/)"""
        ))
    except Exception:
        return ""


def click_role_by_text(page: Page, pattern: str, timeout: int = 900) -> bool:
    regex = re.compile(pattern, re.I)
    candidates = [
        page.get_by_role("button", name=regex),
        page.get_by_role("link", name=regex),
        page.get_by_role("menuitem", name=regex),
    ]

    for locator in candidates:
        item = visible_first(locator, timeout)
        if item:
            try:
                item.click(timeout=timeout)
                return True
            except Exception:
                continue
    return False


def click_visible_text(page: Page, text: str, timeout: int = 900) -> bool:
    if not text:
        return False

    pattern = re.escape(text)
    locators = [
        page.get_by_role("button", name=re.compile(pattern, re.I)),
        page.get_by_role("tab", name=re.compile(pattern, re.I)),
        page.get_by_role("menuitem", name=re.compile(pattern, re.I)),
        page.get_by_role("option", name=re.compile(pattern, re.I)),
        page.get_by_text(re.compile(pattern, re.I)),
    ]

    for locator in locators:
        item = visible_first(locator, timeout)
        if not item:
            continue
        try:
            item.click(timeout=timeout)
            return True
        except Exception:
            continue
    return False


def choose_flow_option(page: Page, value: str, debug: FlowDebug, openers: Optional[List[str]] = None) -> bool:
    if not value:
        return False

    if click_visible_text(page, value, 700):
        debug.log(f"[BOT] ✅ Đã chọn: {value}")
        page.wait_for_timeout(700)
        return True

    for opener in openers or []:
        if click_visible_text(page, opener, 700):
            page.wait_for_timeout(700)
            if click_visible_text(page, value, 1000):
                debug.log(f"[BOT] ✅ Đã chọn {value} qua {opener}")
                page.wait_for_timeout(700)
                return True

    debug.log(f"[BOT] ⚠️ Không tìm thấy option {value}, bỏ qua.")
    return False


def choose_image_settings(page: Page, job: Dict[str, Any], debug: FlowDebug) -> None:
    options = job.get("options") if isinstance(job.get("options"), dict) else {}
    model = str(options.get("imageModel") or options.get("model") or "Nano Banana")
    ratio = str(options.get("imageRatio") or options.get("ratio") or "")
    resolution = str(options.get("imageResolution") or options.get("resolution") or "")

    click_visible_text(page, "Tác nhân", 1000)
    page.wait_for_timeout(500)

    # Chọn Tab Hình ảnh
    click_visible_text(page, "Hình ảnh", 700)
    
    if ratio:
        click_visible_text(page, ratio, 700)
    if resolution:
        click_visible_text(page, resolution, 700)

    # Nếu có model, click dropdown để chọn model
    if model:
        # Tìm nút menu thả xuống (dropdown) có icon arrow_drop_down
        dropdowns = visible_locators(page.locator('button[aria-haspopup="menu"]'), 500)
        if dropdowns:
            # Dropdown cuối cùng thường là dropdown chọn Model
            dropdowns[-1].click()
            page.wait_for_timeout(500)
        click_visible_text(page, model, 700)


def choose_video_settings(page: Page, job: Dict[str, Any], debug: FlowDebug) -> None:
    options = job.get("options") if isinstance(job.get("options"), dict) else {}
    model = str(options.get("videoModel") or options.get("model") or "Veo 3")
    ratio = str(options.get("videoRatio") or options.get("ratio") or "")
    resolution = str(options.get("videoResolution") or options.get("resolution") or "")
    mode = str(options.get("videoMode") or options.get("mode") or "Thành phần") # Frames -> Khung hình, References -> Thành phần
    duration = str(options.get("videoDuration") or options.get("duration") or "")

    click_visible_text(page, "Tác nhân", 1000)
    page.wait_for_timeout(500)

    # Chọn Tab Video
    click_visible_text(page, "Video", 700)
    
    if mode:
        click_visible_text(page, mode, 700)
    if ratio:
        click_visible_text(page, ratio, 700)
    if resolution:
        click_visible_text(page, resolution, 700)
    if duration:
        click_visible_text(page, duration, 700)

    # Chọn Model
    if model:
        dropdowns = visible_locators(page.locator('button[aria-haspopup="menu"]'), 500)
        if dropdowns:
            dropdowns[-1].click()
            page.wait_for_timeout(500)
        click_visible_text(page, model, 700)


def prompt_input_exists(page: Page) -> bool:
    return find_prompt_input(page, raise_on_missing=False) is not None


def enter_flow_workspace(page: Page, debug: FlowDebug) -> None:
    debug.log(f"opened {page.url}")
    debug.screenshot(page, "opened")

    login_text = page.get_by_text(re.compile(r"sign in|log in|dang nhap", re.I))
    if visible_first(login_text, 500):
        debug.screenshot(page, "login_required")
        raise RuntimeError("[BOT] ❌ Lỗi: Google Flow đang yêu cầu đăng nhập. Bạn hãy chạy file login.bat để đăng nhập trước nhé!")

    if prompt_input_exists(page):
        debug.log("composer already visible")
        return

    custom_entry = os.environ.get("FLOW_ENTRY_BUTTON_TEXT", "").strip()
    entry_patterns = [
        re.escape(custom_entry) if custom_entry else "",
        r"Create with Google Flow",
        r"Create with Flow",
        r"Try Flow",
        r"Open Flow",
        r"Get started",
        r"Start creating",
        r"Create new",
        r"New project",
        r"New scene",
        r"Dự án mới",
        r"Tạo dự án mới",
    ]

    entry_patterns = [pattern for pattern in entry_patterns if pattern]

    for _ in range(4):
        for pattern in entry_patterns:
            if click_role_by_text(page, pattern):
                debug.log(f"clicked entry button: {pattern}")
                page.wait_for_timeout(2500)
                debug.screenshot(page, f"after_{pattern}")
                if prompt_input_exists(page):
                    return
        page.wait_for_timeout(1000)

    if not prompt_input_exists(page):
        debug.screenshot(page, "composer_not_found")
        raise RuntimeError("[BOT] ❌ Lỗi: Không tìm thấy ô nhập Prompt (Composer). Có thể mạng chậm hoặc bị che bởi popup. Hãy xem ảnh Screenshot lỗi!")


def ensure_new_project(page: Page, debug: FlowDebug) -> None:
    patterns = [
        r"New project",
        r"Create project",
        r"Start a new project",
        r"New film",
        r"Create new",
        r"New scene",
        r"Dự án mới",
        r"Tạo dự án mới",
    ]

    for pattern in patterns:
        if click_role_by_text(page, pattern):
            debug.log(f"clicked new project control: {pattern}")
            page.wait_for_timeout(2500)
            debug.screenshot(page, f"after_new_project_{pattern}")
            return

    debug.log("new project control not found; continuing in current Flow workspace")


def locator_score(locator: Locator) -> float:
    try:
        box = locator.bounding_box()
        text = normalized_text(locator).lower()
    except Exception:
        return -1.0

    if not box:
        return -1.0

    if any(blocked in text for blocked in ["search", "filter", "email", "password", "project name"]):
        return -1.0

    score = float(box["width"] * box["height"]) + float(box["y"] * 2)
    if any(word in text for word in ["prompt", "describe", "ask", "create", "type", "message"]):
        score += 100000.0
    if box["height"] < 20 or box["width"] < 120:
        score -= 10000.0
    return score


def find_prompt_input(page: Page, raise_on_missing: bool = True) -> Optional[Locator]:
    custom = os.environ.get("FLOW_PROMPT_SELECTOR", "").strip()
    if custom:
        item = visible_first(page.locator(custom), 800)
        if item:
            return item

    selectors = [
        '[data-slate-editor="true"]',
        "textarea",
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]',
        'div[role="textbox"]',
        'input[type="text"]',
    ]

    best: Optional[Locator] = None
    best_score = -1.0

    for selector in selectors:
        for item in visible_locators(page.locator(selector), 400):
            score = locator_score(item)
            if score > best_score:
                best_score = score
                best = item

    if best:
        return best

    if raise_on_missing:
        raise RuntimeError("[BOT] ❌ Lỗi: Không tìm thấy ô nhập Prompt nào có thể dùng được.")
    return None


def click_near_prompt_button(page: Page, prompt: Locator, keywords: List[str]) -> bool:
    box = prompt.bounding_box()
    if not box:
        return False

    script = """
    ({ box, keywords }) => {
      const candidates = Array.from(document.querySelectorAll('button,[role="button"],a[role="button"]'));
      const keywordList = keywords.map((item) => item.toLowerCase());
      const scoreItem = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return null;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return null;
        const text = [
          el.innerText || '',
          el.textContent || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || ''
        ].join(' ').toLowerCase();
        const hasKeyword = keywordList.some((keyword) => text.includes(keyword));
        if (!hasKeyword) return null;
        const dx = Math.max(0, Math.max(box.x - rect.right, rect.left - (box.x + box.width)));
        const dy = Math.max(0, Math.max(box.y - rect.bottom, rect.top - (box.y + box.height)));
        const distance = Math.sqrt(dx * dx + dy * dy);
        return { el, distance, area: rect.width * rect.height };
      };
      const matches = candidates.map(scoreItem).filter(Boolean).sort((a, b) => a.distance - b.distance || b.area - a.area);
      if (!matches.length || matches[0].distance > 500) return false;
      matches[0].el.click();
      return true;
    }
    """
    return bool(page.evaluate(script, {"box": box, "keywords": keywords}))


def upload_files(page: Page, prompt: Locator, files: List[str], debug: FlowDebug) -> None:
    if not files:
        return

    # 1. Tải file ngầm lên gallery bằng input ẩn (Bulk upload)
    inputs = page.locator('input[type="file"]')
    if inputs.count() > 0:
        target = inputs.nth(inputs.count() - 1)
        try:
            target.set_input_files(files)
            debug.log(f"[BOT] ☁️ Đã đẩy {len(files)} file lên hệ thống ngầm.")
            debug.log("[BOT] ⏳ Đang chờ 30 giây để đảm bảo tất cả ảnh được tải lên thành công...")
            page.wait_for_timeout(30000)
        except Exception:
            debug.log("[BOT] ⚠️ Đẩy file ngầm thất bại, sẽ thử tải lên từng file.")

    # 2. Lặp qua từng file để thêm vào câu lệnh (Attach)
    debug.log(f"[BOT] ☁️ Đang đính kèm lần lượt {len(files)} ảnh vào ô chat...")
    for file_path in files:
        filename = os.path.basename(file_path)
        
        # Mở menu [+]
        add_btn = page.locator("button", has=page.locator("i", has_text="add_2")).first
        if visible_first(add_btn, 2000):
            add_btn.click()
            page.wait_for_timeout(1000)
        else:
            debug.log("[BOT] ⚠️ Không tìm thấy nút [+], thử các nút cũ...")
            click_near_prompt_button(page, prompt, ["upload", "attach", "add", "image", "media", "asset", "+"])
            page.wait_for_timeout(1000)
            
        # Tìm ảnh trong thư viện
        img_loc = page.locator(f"img[alt='{filename}']").first
        
        # Mặc dù đã chờ 30s, dự phòng chờ thêm 10s nếu list ảnh dài (ảo hoá)
        if not visible_first(img_loc, 10000):
            debug.log(f"[BOT] ❌ Lỗi: Không tìm thấy ảnh {filename} trong thư viện sau 30s. Bỏ qua.")
            continue
                
        # Click chọn ảnh
        try:
            img_loc.click(timeout=5000, force=True)
            page.wait_for_timeout(500)
        except Exception:
            debug.log(f"[BOT] ⚠️ Lỗi click ảnh {filename}, có thể bị che khuất. Bỏ qua.")
            continue
        
        # Bấm Thêm vào câu lệnh
        add_to_prompt = page.locator("button", has_text="Thêm vào câu lệnh").first
        
        # Nếu nút Thêm vào câu lệnh không hiện (có thể do click làm deselect)
        if not visible_first(add_to_prompt, 1000):
            try:
                img_loc.click(timeout=3000, force=True) # Click lại để chọn
                page.wait_for_timeout(500)
            except Exception:
                pass
            
        if visible_first(add_to_prompt, 2000):
            try:
                add_to_prompt.click(timeout=5000, force=True)
                debug.log(f"[BOT] ✅ Đã thêm {filename} vào câu lệnh.")
                page.wait_for_timeout(1000)
            except Exception:
                debug.log(f"[BOT] ⚠️ Lỗi click nút 'Thêm vào câu lệnh' cho {filename}.")
        else:
            debug.log(f"[BOT] ⚠️ Không tìm thấy nút 'Thêm vào câu lệnh' cho {filename}.")
            
    debug.log("[BOT] ✅ Đính kèm tất cả file thành công!")


def fill_prompt(prompt_input: Locator, prompt: str, page: Page, debug: FlowDebug) -> None:
    try:
        textbox = page.locator('div[role="textbox"][data-slate-editor="true"]').first
        
        # Playwright hỗ trợ fill() native cho contenteditable="true"
        # Hàm này sẽ tự động focus, bôi đen xoá cũ và gõ chữ vào
        try:
            textbox.fill(prompt, timeout=5000)
            page.wait_for_timeout(500)
        except Exception as e:
            debug.log(f"[BOT] ⚠️ fill() thất bại, thử gõ tuần tự... ({e})")
            textbox.click(force=True)
            page.wait_for_timeout(500)
            textbox.press_sequentially(prompt, delay=10)
            page.wait_for_timeout(500)

        # Kiểm tra xem chữ đã thực sự vào chưa (tránh bị SlateJS chặn)
        text_content = textbox.text_content() or ""
        # Nếu chữ chưa vào, text_content thường sẽ chứa chữ của Placeholder "Bạn muốn tạo gì?"
        if prompt not in text_content:
            debug.log("[BOT] ⚠️ Chữ bị bay màu, dùng tuyệt chiêu Paste Event...")
            js_code = """(el, text) => {
                const dataTransfer = new DataTransfer();
                dataTransfer.setData('text/plain', text);
                const pasteEvent = new ClipboardEvent('paste', {
                    clipboardData: dataTransfer,
                    bubbles: true,
                    cancelable: true
                });
                el.dispatchEvent(pasteEvent);
            }"""
            textbox.evaluate(js_code, prompt)
            page.wait_for_timeout(1000)
            
    except Exception as e:
        debug.log(f"[BOT] ⚠️ Lỗi khi gõ prompt: {e}")
    debug.log("filled prompt")


def collect_media_sources(page: Page) -> Set[str]:
    script = """
    () => Array.from(document.querySelectorAll('img,video,video source,canvas')).map((el, index) => {
      const rect = el.getBoundingClientRect();
      const src = el.currentSrc || el.src || el.getAttribute('src') || '';
      return `${el.tagName}:${src}:${Math.round(rect.width)}x${Math.round(rect.height)}:${index}`;
    })
    """
    try:
        return set(str(item) for item in page.evaluate(script))
    except Exception:
        return set()


def submit_prompt(page: Page, prompt_input: Locator, debug: FlowDebug) -> None:
    custom = os.environ.get("FLOW_SUBMIT_SELECTOR", "").strip()
    if custom:
        item = visible_first(page.locator(custom), 1200)
        if item:
            item.click()
            debug.log("clicked custom submit selector")
            page.wait_for_timeout(3000)
            return

    clicked = click_near_prompt_button(page, prompt_input, [
        "send", "submit", "generate", "create", "start", "run", "make", "arrow", "go",
    ])
    if clicked:
        debug.log("clicked composer submit button")
        page.wait_for_timeout(3000)
        return

    page.keyboard.press("Control+Enter")
    page.wait_for_timeout(1000)
    page.keyboard.press("Enter")
    debug.log("submitted prompt with keyboard")
    page.wait_for_timeout(3000)


def media_candidates(page: Page, media_type: str, baseline: Set[str]) -> List[Locator]:
    selector = "video, video source" if media_type == "video" else "img, canvas"
    candidates: List[Locator] = []
    locator = page.locator(selector)

    for index in range(locator.count()):
        item = locator.nth(index)
        try:
            if not item.is_visible(timeout=500):
                continue
            box = item.bounding_box()
            if not box or box["width"] < 120 or box["height"] < 80:
                continue
            signature = item.evaluate(
                """(el, index) => {
                  const rect = el.getBoundingClientRect();
                  const src = el.currentSrc || el.src || el.getAttribute('src') || '';
                  return `${el.tagName}:${src}:${Math.round(rect.width)}x${Math.round(rect.height)}:${index}`;
                }""",
                index,
            )
            if str(signature) in baseline:
                continue
            candidates.append(item)
        except Exception:
            continue

    return sorted(candidates, key=lambda loc: ((loc.bounding_box() or {"width": 0, "height": 0})["width"] * (loc.bounding_box() or {"width": 0, "height": 0})["height"]), reverse=True)


def wait_for_generated_media(page: Page, media_type: str, baseline: Set[str], debug: FlowDebug) -> Locator:
    timeout_seconds = 30 * 60 if media_type == "video" else 10 * 60
    deadline = time.time() + timeout_seconds

    while time.time() < deadline:
        candidates = media_candidates(page, media_type, baseline)
        if candidates:
            debug.log(f"found generated {media_type}")
            return candidates[0]

        blocked = page.get_by_text(re.compile(r"failed|error|policy|violat|could not|try again", re.I))
        if visible_first(blocked, 300):
            debug.screenshot(page, "flow_error_visible")
            raise RuntimeError("[BOT] ❌ Lỗi: Google Flow hiển thị thông báo lỗi hoặc vi phạm chính sách (Policy/Error).")

        page.wait_for_timeout(3000)

    debug.screenshot(page, "media_timeout")
    raise RuntimeError(f"[BOT] ❌ Lỗi: Quá thời gian chờ (Timeout) khi hệ thống đang xử lý sinh {media_type}.")


def fetch_src_from_browser(page: Page, src: str, output_path: Path) -> bool:
    if src.startswith("data:"):
        _header, encoded = src.split(",", 1)
        output_path.write_bytes(base64.b64decode(encoded))
        return True

    script = """
    async (src) => {
      const response = await fetch(src);
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    }
    """
    encoded = page.evaluate(script, src)
    output_path.write_bytes(base64.b64decode(encoded))
    return output_path.exists() and output_path.stat().st_size > 0


def save_media_locator(page: Page, media: Locator, media_type: str, output_path: Path) -> None:
    if media_type == "video":
        src = media.get_attribute("src")
        if not src:
            try:
                src = media.evaluate("el => el.currentSrc || el.src || ''")
            except Exception:
                src = ""
        if not src:
            raise RuntimeError("[BOT] ❌ Lỗi: Đã sinh ra Video nhưng không thể trích xuất được link tải (src/currentSrc bị rỗng).")
        fetch_src_from_browser(page, src, output_path)
        return

    src = media.get_attribute("src")
    if src:
        try:
            if fetch_src_from_browser(page, src, output_path):
                return
        except Exception:
            pass

    media.screenshot(path=str(output_path))


def try_download_near_media(page: Page, media: Locator, output_path: Path, debug: FlowDebug) -> bool:
    custom = os.environ.get("FLOW_DOWNLOAD_SELECTOR", "").strip()
    if custom:
        item = visible_first(page.locator(custom), 1200)
        if item:
            try:
                with page.expect_download(timeout=8000) as download_info:
                    item.click()
                download_info.value.save_as(str(output_path))
                return output_path.exists() and output_path.stat().st_size > 0
            except Exception:
                debug.log("custom download selector did not produce a download")

    box = media.bounding_box()
    if not box:
        return False

    script = """
    ({ box }) => {
      const keywords = ['download', 'export', 'save', 'more'];
      const candidates = Array.from(document.querySelectorAll('button,[role="button"],a'));
      const matches = candidates.map((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return null;
        const text = [
          el.innerText || '',
          el.textContent || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || ''
        ].join(' ').toLowerCase();
        if (!keywords.some((keyword) => text.includes(keyword))) return null;
        const dx = Math.max(0, Math.max(box.x - rect.right, rect.left - (box.x + box.width)));
        const dy = Math.max(0, Math.max(box.y - rect.bottom, rect.top - (box.y + box.height)));
        return { el, distance: Math.sqrt(dx * dx + dy * dy) };
      }).filter(Boolean).sort((a, b) => a.distance - b.distance);
      if (!matches.length || matches[0].distance > 400) return false;
      matches[0].el.click();
      return true;
    }
    """

    try:
        with page.expect_download(timeout=8000) as download_info:
            clicked = page.evaluate(script, {"box": box})
            if not clicked:
                return False
        download_info.value.save_as(str(output_path))
        return output_path.exists() and output_path.stat().st_size > 0
    except Exception:
        return False


def open_flow_target(page: Page, job: Dict[str, Any], debug: FlowDebug) -> None:
    target = str(job.get("project_url") or job.get("flow_url"))
    page.goto(target, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(4000)
    enter_flow_workspace(page, debug)

    if bool(job.get("create_project")):
        ensure_new_project(page, debug)


def run_generation_step(
    page: Page,
    job: Dict[str, Any],
    debug: FlowDebug,
    media_type: str,
    prompt_text: str,
    upload_paths: List[str],
    output_path: Path,
) -> Path:
    debug.log(f"[BOT] ⚙️ Đang cấu hình cài đặt cho {media_type}...")
    if media_type == "image":
        choose_image_settings(page, job, debug)
    else:
        choose_video_settings(page, job, debug)

    prompt_input = find_prompt_input(page)
    upload_files(page, prompt_input, upload_paths, debug)
    prompt_input = find_prompt_input(page)
    fill_prompt(prompt_input, prompt_text, page, debug)

    baseline = collect_media_sources(page)
    submit_prompt(page, prompt_input, debug)
    debug.screenshot(page, f"after_submit_{media_type}")

    media = wait_for_generated_media(page, media_type, baseline, debug)

    if try_download_near_media(page, media, output_path, debug):
        debug.log(f"downloaded {media_type} to {output_path}")
        return output_path

    save_media_locator(page, media, media_type, output_path)
    debug.log(f"saved {media_type} to {output_path}")
    return output_path


def process_single_media_job(page: Page, job: Dict[str, Any], debug: FlowDebug) -> Dict[str, Path]:
    media_type = str(job["type"])
    output_dir = Path(job["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)

    ext = "mp4" if media_type == "video" else "png"
    output_path = output_dir / result_filename(job, ext)
    upload_paths = prepare_upload_files(job)

    open_flow_target(page, job, debug)
    result_path = run_generation_step(
        page=page,
        job=job,
        debug=debug,
        media_type=media_type,
        prompt_text=str(job.get("prompt") or ""),
        upload_paths=upload_paths,
        output_path=output_path,
    )

    return {"result": result_path}


def process_scene_job(page: Page, job: Dict[str, Any], debug: FlowDebug) -> Dict[str, Path]:
    output_dir = Path(job["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)

    debug.log("[BOT] 🌐 Đang mở trang web Google Flow...")
    open_flow_target(page, job, debug)

    image_path = output_dir / result_filename({**job, "type": "image"}, "png")
    reference_paths = prepare_upload_files({**job, "source_image_url": None})
    
    debug.log("[BOT] 🎬 [1/2] Bắt đầu quá trình tạo Ảnh (Image Generation)...")
    run_generation_step(
        page=page,
        job=job,
        debug=debug,
        media_type="image",
        prompt_text=str(job.get("image_prompt") or ""),
        upload_paths=reference_paths,
        output_path=image_path,
    )

    debug.log("[BOT] 🎬 [2/2] Bắt đầu quá trình tạo Video từ Ảnh vừa tạo...")
    video_path = output_dir / result_filename({**job, "type": "video"}, "mp4")
    run_generation_step(
        page=page,
        job=job,
        debug=debug,
        media_type="video",
        prompt_text=str(job.get("video_prompt") or ""),
        upload_paths=[str(image_path)],
        output_path=video_path,
    )

    debug.log("[BOT] 🎊 Hoàn thành toàn bộ Scene!")
    return {
        "image": image_path,
        "video": video_path,
    }


def run_job(job: Dict[str, Any]) -> Dict[str, Any]:
    prompt_hash = hashlib.md5(str(job.get("prompt", "")).encode("utf-8")).hexdigest()
    profile = str(job.get("profile") or "default")
    debug = FlowDebug(job)
    page: Optional[Page] = None

    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=get_profile_path(profile),
                headless=bool(job.get("headless")),
                channel="chrome",
                args=chrome_launch_args(),
                ignore_default_args=["--enable-automation"],
                no_viewport=True if not job.get("headless") else False,
                accept_downloads=True,
                slow_mo=250,
            )

            try:
                page = context.pages[0] if context.pages else context.new_page()
                if str(job.get("type")) == "scene":
                    output_paths = process_scene_job(page, job, debug)
                else:
                    output_paths = process_single_media_job(page, job, debug)
            finally:
                context.close()

        if str(job.get("type")) == "scene":
            image_path = output_paths["image"]
            video_path = output_paths["video"]
            return {
                "status": "success",
                "type": "scene",
                "result_url": public_url(job, video_path),
                "image_result_url": public_url(job, image_path),
                "image_local_path": str(image_path),
                "video_result_url": public_url(job, video_path),
                "video_local_path": str(video_path),
                "project_url": page.url if page else "",
                "prompt_hash": prompt_hash,
                "profile_used": profile,
                "debug_dir": str(debug.dir),
                "debug_steps": debug.steps,
            }

        output_path = output_paths["result"]
        return {
            "status": "success",
            "type": job["type"],
            "result_url": public_url(job, output_path),
            "local_path": str(output_path),
            "project_url": page.url if page else "",
            "prompt_hash": prompt_hash,
            "profile_used": profile,
            "debug_dir": str(debug.dir),
            "debug_steps": debug.steps,
        }
    except Exception as exc:
        shot = debug.screenshot(page, "error") if page else None
        raise RuntimeError(f"{exc}. Debug: {shot or debug.dir}") from exc


def load_job_from_args() -> Dict[str, Any]:
    parser = argparse.ArgumentParser(description="Google Flow browser automation")
    parser.add_argument("--job", type=str, help="Path to JSON job payload")
    parser.add_argument("--type", choices=["image", "video"], help="Legacy media type")
    parser.add_argument("--prompt", type=str, help="Legacy prompt")
    parser.add_argument("--profile", type=str, default="default")
    parser.add_argument("--headless", action="store_true", default=False)
    parser.add_argument("--visible", dest="headless", action="store_false")
    args = parser.parse_args()

    if args.job:
        with open(args.job, "r", encoding="utf-8") as handle:
            return json.load(handle)

    if not args.type or not args.prompt:
        raise RuntimeError("--job or both --type/--prompt are required")

    output_dir = ROOT_DIR / "generated"
    return {
        "type": args.type,
        "prompt": args.prompt,
        "profile": args.profile,
        "flow_url": os.environ.get("GOOGLE_FLOW_URL", "https://flow.google/"),
        "headless": args.headless,
        "output_dir": str(output_dir),
        "public_base_url": "http://localhost:3000/generated",
        "file_prefix": "manual",
        "scene_index": 1,
        "reference_images": [],
        "options": {},
    }


def main() -> None:
    try:
        job = load_job_from_args()
        result = run_job(job)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"status": "error", "message": str(exc)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
