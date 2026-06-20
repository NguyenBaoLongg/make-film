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
            print(message, file=sys.stderr, flush=True)
        else:
            print(f"Progress: {message}", file=sys.stderr, flush=True)

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


def emit_flow_event(job: Dict[str, Any], event: str, data: Dict[str, Any]) -> None:
    payload = {
        "event": event,
        "data": {
            "scene_index": int(job.get("scene_index") or 1),
            **data,
        },
    }
    print(f"FLOW_EVENT {json.dumps(payload, ensure_ascii=False)}", file=sys.stderr, flush=True)


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
        page.get_by_role("menuitem", name=re.compile(pattern, re.I)),
        page.get_by_role("option", name=re.compile(pattern, re.I)),
        page.get_by_role("tab", name=re.compile(pattern, re.I)),
        page.get_by_role("button", name=re.compile(pattern, re.I)),
        page.get_by_text(re.compile(pattern, re.I)),
    ]

    for locator in locators:
        item = visible_first(locator, timeout)
        if not item:
            continue
        try:
            # Ngăn click nhầm vào nút Profile (ví dụ tài khoản tên ULTRA trùng với model ULTRA)
            is_profile = item.evaluate("el => !!el.querySelector('img[alt*=\"hồ sơ\"], img[alt*=\"profile\"], img[alt*=\"Profile\"]') || (el.tagName === 'IMG' && el.alt && (el.alt.includes('hồ sơ') || el.alt.includes('profile')))")
            if is_profile:
                continue
                
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

    # LUÔN ấn nút Tác nhân để mở bảng cấu hình
    agent_btn = page.locator('button', has=page.locator('span.content', has_text="Tác nhân")).first
    try:
        agent_btn.wait_for(state="visible", timeout=3000)
        # Trên Google Flow: aria-pressed="false" = BẬT, aria-pressed="true" = TẮT
        if agent_btn.get_attribute("aria-pressed") != "false":
            agent_btn.click()
            page.wait_for_timeout(1000)
            debug.log("[BOT] Đã bật lại nút Tác nhân.")
    except Exception:
        debug.log("[BOT] ⚠️ Không tìm thấy nút Tác nhân (có thể UI đã đổi).")

    # Mở menu Quick Settings (nút có chứa tên model hiện tại như "🍌 Nano Banana 2")
    quick_settings_btn = page.locator('button[aria-haspopup="menu"]').last
    if visible_first(quick_settings_btn, 1000):
        if quick_settings_btn.get_attribute("aria-expanded") != "true":
            try:
                quick_settings_btn.click(timeout=2000)
                page.wait_for_timeout(1000)
            except Exception:
                pass

    # Chọn Tab Hình ảnh (Cực kỳ quan trọng: chỉ chọn khi đang ở node Hình ảnh)
    image_tab = page.locator('button[role="tab"]', has_text="Hình ảnh").first
    if visible_first(image_tab, 1500):
        image_tab.click(timeout=2000)
        page.wait_for_timeout(1000)
        debug.log("[BOT] ✅ Đã chọn Tab Hình ảnh")
    
    # Chọn Ratio
    if ratio:
        ratio_tab = page.locator('button[role="tab"]', has_text=ratio).first
        if visible_first(ratio_tab, 1000):
            ratio_tab.click()
            page.wait_for_timeout(500)

    # Chọn Model
    if model:
        dropdowns = page.locator('button[aria-haspopup="menu"]')
        for i in range(dropdowns.count()):
            try:
                text_content = dropdowns.nth(i).text_content()
                if text_content and "Nano Banana" in text_content or "Imagen" in text_content:
                    dropdowns.nth(i).click()
                    page.wait_for_timeout(500)
                    model_item = page.locator('[role="menuitem"]', has_text=model).first
                    if visible_first(model_item, 1000):
                        model_item.click()
                        page.wait_for_timeout(500)
                    break
            except Exception:
                pass



def choose_video_settings(page: Page, job: Dict[str, Any], debug: FlowDebug) -> None:
    options = job.get("options") if isinstance(job.get("options"), dict) else {}
    model = str(options.get("videoModel") or options.get("model") or "Veo 3.1 - Lite [Lower Priority]")
    ratio = str(options.get("videoRatio") or options.get("ratio") or "16:9")
    mode = str(options.get("videoMode") or options.get("mode") or "Thành phần") # Frames -> Khung hình, References -> Thành phần
    duration = str(options.get("videoDuration") or options.get("duration") or "8s")

    # LUÔN ấn nút Tác nhân để mở bảng cấu hình
    agent_btn = page.locator('button', has=page.locator('span.content', has_text="Tác nhân")).first
    try:
        agent_btn.wait_for(state="visible", timeout=3000)
        # Trên Google Flow: aria-pressed="false" = BẬT, aria-pressed="true" = TẮT
        if agent_btn.get_attribute("aria-pressed") != "false":
            agent_btn.click(timeout=3000)
            page.wait_for_timeout(1500)
            debug.log("[BOT] Đã bật lại nút Tác nhân.")
    except Exception:
        debug.log("[BOT] ⚠️ Không tìm thấy nút Tác nhân (có thể UI đã đổi).")

    # Mở menu Quick Settings (nút có chứa tên model hiện tại)
    quick_settings_btn = page.locator('button[aria-haspopup="menu"]').last
    if visible_first(quick_settings_btn, 1000):
        if quick_settings_btn.get_attribute("aria-expanded") != "true":
            try:
                quick_settings_btn.click(timeout=2000)
                page.wait_for_timeout(1000)
            except Exception:
                pass

    # Chọn Tab Video
    video_tab = page.locator('button[role="tab"]', has_text="Video").first
    if visible_first(video_tab, 1500):
        video_tab.click(timeout=2000)
        page.wait_for_timeout(1000)
        debug.log("[BOT] ✅ Đã chọn Tab Video")

    # Chọn Mode (Khung hình / Thành phần)
    if mode:
        mode_tab = page.locator('button[role="tab"]', has_text=mode).first
        if visible_first(mode_tab, 1000):
            mode_tab.click()
            page.wait_for_timeout(500)

    # Chọn Ratio (16:9 / 9:16)
    if ratio:
        ratio_tab = page.locator('button[role="tab"]', has_text=ratio).first
        if visible_first(ratio_tab, 1000):
            ratio_tab.click()
            page.wait_for_timeout(500)

    # Chọn Duration (4s, 6s, 8s)
    if duration:
        duration_tab = page.locator('button[role="tab"]', has_text=duration).first
        if visible_first(duration_tab, 1000):
            try:
                if duration_tab.get_attribute("disabled") is None:
                    duration_tab.click()
                    page.wait_for_timeout(500)
            except Exception:
                pass

    # Chọn Model
    if model:
        try:
            # Dropdown chọn model trong menu Quick Settings luôn là dropdown cuối cùng
            dropdowns = page.locator('button[aria-haspopup="menu"]')
            if dropdowns.count() > 0:
                dropdowns.last.click()
                page.wait_for_timeout(500)
                
                # Tìm thẻ menuitem có chứa tên model
                model_item = page.locator('[role="menuitem"]', has_text=model).first
                if visible_first(model_item, 1000):
                    model_item.click()
                    page.wait_for_timeout(500)
        except Exception:
            pass



def prompt_input_exists(page: Page) -> bool:
    return find_prompt_input(page, raise_on_missing=False) is not None


def enter_flow_workspace(page: Page, debug: FlowDebug) -> None:
    debug.log(f"opened {page.url}")
    debug.screenshot(page, "opened")

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
                
                # Sau khi bấm "Dự án mới", có thể hiện ra popup chọn loại dự án. 
                # Tìm và bấm "Dự án trống", "Bản thảo trống" hoặc "Blank"
                blank_patterns = [r"Blank", r"Dự án trống", r"Bản thảo trống", r"Tạo mới"]
                for bp in blank_patterns:
                    if click_role_by_text(page, bp, timeout=1000):
                        debug.log(f"clicked blank project option: {bp}")
                        page.wait_for_timeout(2000)
                        break
                        
                # Ấn ESC phòng trường hợp có popup hướng dẫn che màn hình
                page.keyboard.press("Escape")
                page.wait_for_timeout(500)
                
                debug.screenshot(page, f"after_{pattern}")
                if prompt_input_exists(page):
                    return
        page.wait_for_timeout(1000)

    if not prompt_input_exists(page):
        # Cứ thử ấn ESC vài lần xem có phải do popup che không
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        page.wait_for_timeout(1000)
        if prompt_input_exists(page):
            return
            
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


def composer_attachment_count(page: Page, prompt: Locator) -> int:
    box = prompt.bounding_box()
    if not box:
        return 0

    script = """
    (box) => {
      const media = Array.from(document.querySelectorAll('img,canvas,video'));
      return media.filter((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 24) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
        const dx = Math.max(0, Math.max(box.x - rect.right, rect.left - (box.x + box.width)));
        const dy = Math.max(0, Math.max((box.y - 320) - rect.bottom, rect.top - (box.y + box.height + 320)));
        return Math.sqrt(dx * dx + dy * dy) < 520;
      }).length;
    }
    """
    try:
        return int(page.evaluate(script, box))
    except Exception:
        return 0


def wait_for_attachment_count(page: Page, prompt: Locator, minimum: int, timeout_ms: int = 45000) -> bool:
    deadline = time.time() + (timeout_ms / 1000)
    while time.time() < deadline:
        if composer_attachment_count(page, prompt) >= minimum:
            return True
        page.wait_for_timeout(1000)
    return False


def uploaded_asset_locator(page: Page, filename: str) -> Optional[Locator]:
    patterns = [filename, Path(filename).stem]
    for pattern in patterns:
        if not pattern:
            continue
        escaped = re.escape(pattern)
        locators = [
            page.locator(f"img[alt*=\"{pattern}\"]"),
            page.locator(f"[aria-label*=\"{pattern}\"]"),
            page.locator(f"[title*=\"{pattern}\"]"),
            page.get_by_text(re.compile(escaped, re.I)),
        ]
        for locator in locators:
            item = visible_first(locator.first, 1200)
            if item:
                return item
    return None


def upload_files(page: Page, prompt: Locator, files: List[str], debug: FlowDebug) -> int:
    if not files:
        return 0

    attached = 0

    debug.log(f"[BOT] ☁️ Đang đính kèm lần lượt {len(files)} ảnh vào ô chat...")

    # JS đếm số thumbnail đã attach trong vùng prompt
    COUNT_ATTACHED_JS = """
    () => {
      // Đếm ảnh thumbnail gần prompt (ảnh nhỏ đã attach, thường nằm trong container trên prompt)
      const imgs = document.querySelectorAll('img');
      let count = 0;
      for (const img of imgs) {
        const rect = img.getBoundingClientRect();
        // Thumbnail thường kích thước 30-80px, nằm ở nửa dưới màn hình (gần prompt)
        if (rect.width > 20 && rect.width < 120 && rect.height > 20 && rect.height < 120 && rect.bottom > window.innerHeight * 0.5) {
          count++;
        }
      }
      return count;
    }
    """

    for file_path in files:
        filename = os.path.basename(file_path)

        # Đếm số ảnh đã attach TRƯỚC khi upload
        count_before = page.evaluate(COUNT_ATTACHED_JS)

        # ── Bước 1: Mở menu [+] ──
        add_btn = page.locator('button', has=page.locator('i', has_text="add_2")).first
        if visible_first(add_btn, 2000):
            add_btn.click()
            page.wait_for_timeout(1500)
        else:
            click_near_prompt_button(page, prompt, ["upload", "attach", "add", "image", "media", "asset", "+"])
            page.wait_for_timeout(1500)

        # ── Bước 2: Upload file qua input[type=file] ──
        inputs = page.locator('input[type="file"]')
        if inputs.count() > 0:
            target_input = inputs.nth(inputs.count() - 1)
            try:
                target_input.set_input_files([file_path])
                debug.log(f"[BOT] ☁️ Đã gửi {filename}, đang chờ upload...")
            except Exception as e:
                debug.log(f"[BOT] ⚠️ Lỗi upload {filename}: {e}")
                continue
        else:
            debug.log(f"[BOT] ⚠️ Không tìm thấy input file cho {filename}.")
            continue

        # ── Bước 3: Chờ upload xong và attach file ──
        # Chờ nút "Thêm vào câu lệnh" SÁNG (enabled) rồi mới click
        file_attached = False
        for wait_round in range(10):  # 10 lần x 3s = tối đa 30 giây
            page.wait_for_timeout(3000)

            # Kiểm tra nút "Thêm vào câu lệnh" đã SÁNG (enabled) chưa
            add_to_prompt = page.locator("button", has_text="Thêm vào câu lệnh").first
            if visible_first(add_to_prompt, 1000):
                try:
                    is_enabled = add_to_prompt.is_enabled()
                    is_not_disabled = add_to_prompt.get_attribute("disabled") is None
                    aria_ok = add_to_prompt.get_attribute("aria-disabled") != "true"
                    
                    if is_enabled and is_not_disabled and aria_ok:
                        add_to_prompt.click(timeout=5000)
                        attached += 1
                        file_attached = True
                        debug.log(f"[BOT] ✅ Đã ấn 'Thêm vào câu lệnh' cho {filename}.")
                        page.wait_for_timeout(1000)
                        break
                    else:
                        debug.log(f"[BOT] ⏳ Nút 'Thêm vào câu lệnh' chưa sáng, chờ thêm... (round {wait_round+1})")
                except Exception:
                    debug.log(f"[BOT] ⚠️ Lỗi kiểm tra/click nút cho {filename}.")

            # Xóa logic đếm thumbnail (auto-attach) vì khi nhảy sang tab Video, các thẻ UI cũng là ảnh nên nó đếm nhầm (0 -> 7)
            # Bắt buộc phải chờ nút "Thêm vào câu lệnh" sáng lên và bấm.

        if file_attached:
            continue

        # Nếu không tự attach, thử tìm trong gallery và bấm "Thêm vào câu lệnh"
        debug.log(f"[BOT] ⚠️ {filename} chưa auto-attach, thử tìm trong gallery...")

        # Bỏ chọn item cũ (nếu có)
        pre_selected = page.locator('div[role="option"][aria-selected="true"]').first
        if visible_first(pre_selected, 1000):
            try:
                pre_selected.click(timeout=2000)
                page.wait_for_timeout(500)
            except Exception:
                pass

        # Tìm option trong gallery
        option_loc = page.locator('div[role="option"]', has_text=filename).first
        found = visible_first(option_loc, 4000)

        if not found:
            img_loc = page.locator(f"img[alt*='{filename}']").first
            found = visible_first(img_loc, 3000)

        if not found:
            # Cuộn gallery bằng mouse wheel
            gallery = page.locator('[data-viewport-type="element"]').first
            if visible_first(gallery, 1000):
                box = gallery.bounding_box()
                if box:
                    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                    page.mouse.wheel(0, 300)
                    page.wait_for_timeout(800)
                    found = visible_first(option_loc, 3000)

        if not found:
            debug.log(f"[BOT] ❌ Không tìm thấy ảnh {filename} trong thư viện.")
            continue

        try:
            found.click(timeout=5000)
            page.wait_for_timeout(1000)
        except Exception:
            debug.log(f"[BOT] ⚠️ Lỗi click option {filename}.")
            continue

        # Bấm "Thêm vào câu lệnh"
        add_to_prompt = page.locator("button", has_text="Thêm vào câu lệnh").first
        if visible_first(add_to_prompt, 5000):
            try:
                add_to_prompt.click(timeout=5000, force=True)
                attached += 1
                debug.log(f"[BOT] ✅ Đã ấn xác nhận Thêm {filename} vào câu lệnh.")
                page.wait_for_timeout(1000)
            except Exception:
                debug.log(f"[BOT] ⚠️ Lỗi click nút 'Thêm vào câu lệnh' cho {filename}.")
        else:
            debug.log(f"[BOT] ❌ Không tìm thấy nút 'Thêm vào câu lệnh' cho {filename}.")

    if attached == 0 and len(files) > 0:
        debug.screenshot(page, "upload_attach_failed")
        raise RuntimeError(f"[BOT] Lỗi nghiêm trọng: Không thể đính kèm BẤT KỲ ảnh nào trong số {len(files)} ảnh vào Google Flow.")
    elif attached < len(files):
        debug.log(f"[BOT] ⚠️ Cảnh báo: Chỉ đính kèm được {attached}/{len(files)} ảnh. Vẫn tiếp tục tạo...")

    debug.log(f"[BOT] Attached {attached}/{len(files)} required file(s) successfully.")
    return attached


def fill_prompt(prompt_input: Locator, prompt: str, page: Page, debug: FlowDebug) -> None:
    try:
        textbox = page.locator('div[role="textbox"][data-slate-editor="true"]').first
        
        textbox.click(force=True)
        page.wait_for_timeout(500)
        
        # Chọn tất cả và xóa chữ cũ
        page.keyboard.press("Control+A")
        page.wait_for_timeout(100)
        page.keyboard.press("Backspace")
        page.wait_for_timeout(500)
        
        debug.log("[BOT] ⌨️ Đang gõ chữ tuần tự...")
        lines = prompt.split('\n')
        for i, line in enumerate(lines):
            if line:
                textbox.press_sequentially(line, delay=10)
            if i < len(lines) - 1:
                page.keyboard.press("Shift+Enter")
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

    # Tìm nút Submit nằm GẦN NHẤT so với ô nhập prompt
    # Loại bỏ keyword "arrow" vì sẽ bị nhầm với "arrow_drop_down" của thẻ chọn Model
    # Thêm đích danh "arrow_forward" và "tạo"
    clicked = click_near_prompt_button(page, prompt_input, [
        "tạo", "create", "generate", "submit", "send", "arrow_forward", "go", "start", "run", "make"
    ])
    
    if clicked:
        debug.log("clicked composer submit button (Near Prompt Match)")
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
            # Đảm bảo ảnh/video đã thực sự tải xong (complete) trên trình duyệt
            try:
                is_ready = candidates[0].evaluate("el => el.complete !== false")
                if not is_ready:
                    page.wait_for_timeout(2000)
                    continue
            except Exception:
                pass
                
            debug.log(f"[BOT] ⏳ Đã tìm thấy {media_type} mới, chờ thêm 15s để đảm bảo render 100% hoàn tất...")
            page.wait_for_timeout(15000)
            return candidates[0]

        blocked = page.get_by_text(re.compile(r"failed|error|policy|violat|could not|try again|không thành công|vi phạm", re.I))
        if visible_first(blocked, 300):
            debug.screenshot(page, "flow_error_visible")
            raise RuntimeError("[BOT] ❌ Lỗi: Google Flow báo lỗi hoặc tạo không thành công (Policy/Error).")

        page.wait_for_timeout(3000)

    debug.screenshot(page, "media_timeout")
    raise RuntimeError(f"[BOT] ❌ Lỗi: Quá thời gian chờ (Timeout) khi hệ thống đang xử lý sinh {media_type}.")


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

    # Di chuột vào giữa ảnh để hiện nút Download nếu nó đang ẩn
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.wait_for_timeout(1000)

    script = """
    ({ box }) => {
      const keywords = ['download', 'export', 'save', 'more', 'tải xuống', 'tải về', 'lưu', 'file_download'];
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
    use_latest_gallery_image: bool = False,
) -> Path:
    debug.log(f"[BOT] ⚙️ Đang cấu hình cài đặt cho {media_type}...")
    if media_type == "image":
        choose_image_settings(page, job, debug)
    else:
        choose_video_settings(page, job, debug)

    prompt_input = find_prompt_input(page)
    
    if use_latest_gallery_image:
        debug.log("[BOT] 🖼️ Sử dụng ảnh vừa tạo trong thư viện thay vì upload lại...")
        # Luôn CLICK để đảm bảo mở menu [+]
        add_btn = page.locator("button", has=page.locator("i", has_text="add_2")).first
        if visible_first(add_btn, 2000):
            add_btn.click()
            page.wait_for_timeout(1500)
        else:
            click_near_prompt_button(page, prompt_input, ["upload", "attach", "add", "image", "media", "asset", "+"])
            page.wait_for_timeout(1500)
            
        # Chọn ảnh đầu tiên trong thư viện (ảnh mới nhất)
        # Giới hạn vùng tìm kiếm trong popup/dialog vừa mở ra để tránh click nhầm ảnh ngoài nền
        dialogs = page.locator('div[role="dialog"], div[data-state="open"]')
        target_container = dialogs.last if dialogs.count() > 0 else page

        gallery_images = target_container.locator('img')
        for i in range(gallery_images.count()):
            img = gallery_images.nth(i)
            box = img.bounding_box()
            # Tăng kích thước tối thiểu lên 70x70 để loại bỏ hoàn toàn các nút/icon rác
            if box and box["width"] > 70 and box["height"] > 70:
                try:
                    img.click(timeout=2000, force=True)
                    page.wait_for_timeout(1000)
                    debug.log("[BOT] Đã click chọn ảnh đầu tiên trong thư viện.")
                    break
                except Exception:
                    continue
                    
        add_to_prompt = page.locator("button", has_text="Thêm vào câu lệnh").first
        if visible_first(add_to_prompt, 2000):
            add_to_prompt.click(timeout=3000, force=True)
            debug.log("[BOT] ✅ Đã thêm ảnh từ thư viện vào câu lệnh.")
            page.wait_for_timeout(1000)
    else:
        upload_files(page, prompt_input, upload_paths, debug)
        if upload_paths:
            debug.log("[BOT] ⏳ Đang chờ hệ thống xử lý ảnh vừa upload...")
            page.wait_for_timeout(15000)

    prompt_input = find_prompt_input(page)
    fill_prompt(prompt_input, prompt_text, page, debug)

    # Lấy danh sách định danh (URL hoặc UUID) của TẤT CẢ media đang có trên trang TRƯỚC KHI submit
    # Điều này cực kỳ quan trọng: nó sẽ thu thập UUID của các ảnh reference đang nằm trong prompt box.
    # Khi render xong, Flow đưa ảnh reference ra ngoài canvas, BOT sẽ không bị nhầm đó là ảnh mới.
    baseline_media = set(page.evaluate("""
    () => {
        const set = new Set();
        Array.from(document.querySelectorAll('img, video, canvas')).forEach(el => {
            const src = el.currentSrc || el.src || el.getAttribute('src') || '';
            if (src) {
                set.add(src);
                try {
                    const url = new URL(src, window.location.origin);
                    const name = url.searchParams.get('name');
                    if (name) set.add(name);
                } catch(e) {}
            }
        });
        return Array.from(set);
    }
    """))
    debug.log(f"[BOT] Baseline: {len(baseline_media)} media identifiers đã lưu trước khi submit.")
    
    # Bấm nút tạo (submit)
    submit_prompt(page, prompt_input, debug)
    debug.log(f"[BOT] ⏳ Đã Submit, đang chờ {media_type} hoàn thành...")

    # Chờ 5s cho UI bắt đầu render
    page.wait_for_timeout(5000)

    # Cố gắng chờ progress bar biến mất (nếu Flow có dùng)
    try:
        progress = page.locator('[role="progressbar"]').first
        if visible_first(progress, 2000):
            debug.log("[BOT] ⏳ Đang render... (phát hiện thanh tiến trình)")
            progress.wait_for(state="hidden", timeout=120000)
            debug.log("[BOT] ✅ Đã render xong (thanh tiến trình biến mất).")
    except Exception:
        pass

    debug.log("[BOT] ⏳ Chờ thêm 15s cho UI ổn định...")
    page.wait_for_timeout(15000)

    try:
        # Chờ ảnh MỚI có alt="Hình ảnh được tạo" xuất hiện (không trùng UUID trong baseline)
        timeout_seconds = 30 * 60 if media_type == "video" else 10 * 60
        deadline = time.time() + timeout_seconds
        target_img = None

        while time.time() < deadline:
            if media_type == "video":
                generated_media = page.locator('video')
            else:
                generated_media = page.locator('img[alt="Hình ảnh được tạo"], img[alt*="được tạo"]')

            for i in range(generated_media.count()):
                media_el = generated_media.nth(i)
                try:
                    if not media_el.is_visible(timeout=500):
                        continue
                    box = media_el.bounding_box()
                    if not box or box["width"] < 100 or box["height"] < 100:
                        continue
                    
                    src = media_el.evaluate("el => el.currentSrc || el.src || ''")
                    if not src:
                        # Video có thể dùng thẻ <source> bên trong
                        src = media_el.evaluate("el => { const srcEl = el.querySelector('source'); return srcEl ? srcEl.src : ''; }")
                        if not src:
                            continue
                        
                    # Lấy UUID từ src để so sánh chính xác (bỏ qua query width/height nếu có)
                    identifier = src
                    try:
                        from urllib.parse import urlparse, parse_qs
                        parsed = urlparse(src)
                        qs = parse_qs(parsed.query)
                        if 'name' in qs:
                            identifier = qs['name'][0]
                    except Exception:
                        pass

                    # CHỈ chọn nếu media này chưa từng xuất hiện trước khi submit
                    if src not in baseline_media and identifier not in baseline_media:
                        if media_type == "video":
                            # Với video, readyState >= 3 có nghĩa là HAVE_FUTURE_DATA (đã tải đủ để phát)
                            is_complete = media_el.evaluate("el => el.readyState >= 3 || el.src.startsWith('blob:')")
                        else:
                            is_complete = media_el.evaluate("el => el.complete === true && el.naturalWidth > 0")
                            
                        if is_complete:
                            target_img = media_el
                            break
                except Exception:
                    continue

            if target_img:
                debug.log(f"[BOT] ⏳ Đã tìm thấy {media_type} mới do AI tạo ra, chờ thêm 5s để render 100%...")
                page.wait_for_timeout(5000)
                break

            # Tự động bấm "Thử lại" nếu bị lỗi "Không thành công" (vi phạm chính sách)
            retry_btn = page.locator('button', has=page.locator('i', has_text="refresh")).filter(has_text=re.compile(r"Thử lại|Retry", re.I)).last
            if visible_first(retry_btn, 500):
                debug.log(f"[BOT] ⚠️ Bị từ chối do vi phạm chính sách hoặc lỗi. Đang tự động ấn 'Thử lại' để tạo lại {media_type}...")
                try:
                    retry_btn.click(timeout=3000)
                    page.wait_for_timeout(5000)
                    deadline = time.time() + timeout_seconds # Reset lại thời gian chờ
                    continue
                except Exception as e:
                    debug.log(f"[BOT] ⚠️ Lỗi khi ấn Thử lại: {e}")

            # Kiểm tra lỗi (Soft check để tránh False Positive)
            blocked = page.get_by_text(re.compile(r"failed|error|policy|violat|could not|try again|không thành công|vi phạm", re.I))
            if visible_first(blocked, 300):
                # Không raise ngay lập tức, chỉ cảnh báo để tránh bắt nhầm text trên UI (ví dụ: nút "Báo lỗi")
                debug.log("[BOT] ⚠️ Cảnh báo: Phát hiện text nghi ngờ lỗi trên UI, nhưng vẫn tiếp tục chờ...")

            page.wait_for_timeout(5000)

        if not target_img:
            debug.screenshot(page, "media_timeout")
            raise RuntimeError(f"[BOT] ❌ Quá thời gian chờ khi hệ thống đang xử lý sinh {media_type}.")

        # KHÔNG click vào ảnh
        src = target_img.evaluate("el => el.currentSrc || el.src || ''")
        debug.log(f"[BOT] ✅ Đã phát hiện {media_type} mới.")
        debug.log(f"[BOT] 🔗 src URL: {src[:120]}...")

        downloaded = False

        # Phương pháp 1: Tải qua Playwright API request (giữ cookie xác thực)
        if src:
            full_url = src if src.startswith("http") else (page.evaluate("window.location.origin") + src)
            try:
                response = page.context.request.get(full_url)
                if response.ok:
                    body = response.body()
                    content_type = response.headers.get("content-type", "")
                    if "image" in content_type or "video" in content_type or len(body) > 10000:
                        output_path.write_bytes(body)
                        debug.log(f"[BOT] 💾 Đã tải {media_type} thành công (content-type: {content_type}, size: {len(body)} bytes).")
                        downloaded = True
                    else:
                        debug.log(f"[BOT] ⚠️ Response không phải media (content-type: {content_type}, size: {len(body)}).")
                else:
                    debug.log(f"[BOT] ⚠️ API request thất bại: HTTP {response.status}")
            except Exception as e:
                debug.log(f"[BOT] ⚠️ Lỗi API request: {e}")

        # Phương pháp 2: Fetch Blob trực tiếp trong trình duyệt (Chuyên trị Video và lỗi Redirect/CORS)
        if not downloaded and src:
            debug.log(f"[BOT] ⚠️ Thử tải qua trình duyệt (fetch blob)...")
            try:
                data_url = page.evaluate("""
                async (url) => {
                    const res = await fetch(url);
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    const blob = await res.blob();
                    return new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result);
                        reader.onerror = reject;
                        reader.readAsDataURL(blob);
                    });
                }
                """, full_url)
                
                if data_url and "," in data_url:
                    import base64
                    header, b64data = data_url.split(",", 1)
                    output_path.write_bytes(base64.b64decode(b64data))
                    if output_path.stat().st_size > 1000:
                        debug.log(f"[BOT] 💾 Đã lưu {media_type} qua fetch blob ({output_path.stat().st_size} bytes).")
                        downloaded = True
            except Exception as e:
                debug.log(f"[BOT] ⚠️ Lỗi fetch blob: {e}")

        # Phương pháp 3: Canvas toDataURL (Fallback cuối cùng cho Image, không dùng được cho Video mp4)
        if not downloaded and media_type != "video":
            debug.log(f"[BOT] ⚠️ Thử tải qua canvas toDataURL...")
            try:
                data_url = target_img.evaluate("""
                el => {
                    const canvas = document.createElement('canvas');
                    canvas.width = el.naturalWidth || el.width;
                    canvas.height = el.naturalHeight || el.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(el, 0, 0);
                    return canvas.toDataURL('image/png');
                }
                """)
                if data_url and data_url.startswith("data:image"):
                    import base64
                    header, b64data = data_url.split(",", 1)
                    output_path.write_bytes(base64.b64decode(b64data))
                    if output_path.stat().st_size > 1000:
                        debug.log(f"[BOT] 💾 Đã lưu {media_type} qua canvas ({output_path.stat().st_size} bytes).")
                        downloaded = True
            except Exception as e:
                debug.log(f"[BOT] ⚠️ Lỗi canvas: {e}")

        if not downloaded:
            debug.screenshot(page, "download_failed")
            raise RuntimeError(f"Không thể tải {media_type}.")

    except Exception as e:
        debug.screenshot(page, "generation_failed")
        raise RuntimeError(f"[BOT] Lỗi khi tạo/tải {media_type}: {str(e)}")

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
    emit_flow_event(job, "image_done", {
        "result_url": public_url(job, image_path),
        "local_path": str(image_path),
    })

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
        use_latest_gallery_image=False, # YÊU CẦU MỚI: Upload ảnh trực tiếp thay vì pick từ gallery
    )
    emit_flow_event(job, "video_done", {
        "result_url": public_url(job, video_path),
        "local_path": str(video_path),
    })

    debug.log("[BOT] 🎊 Hoàn thành toàn bộ Scene!")
    emit_flow_event(job, "scene_done", {
        "result_url": public_url(job, video_path),
        "image_result_url": public_url(job, image_path),
        "image_local_path": str(image_path),
        "video_result_url": public_url(job, video_path),
        "video_local_path": str(video_path),
    })
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
