"""
Google Flow browser worker.

The backend passes a JSON job file. This worker opens a persistent Chrome
profile, uploads reference/source images, submits a prompt, downloads the
generated image/video, and returns a JSON result.
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
from typing import Any, Dict, List, Optional

from playwright.sync_api import Locator, Page, TimeoutError as PlaywrightTimeoutError, sync_playwright


ROOT_DIR = Path(__file__).resolve().parent.parent
PROFILES_DIR = ROOT_DIR / "chrome_profiles"


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
    path = PROFILES_DIR / safe_file_part(profile_name)
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


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

    raise RuntimeError(f"Cannot read image reference: {value[:120]}")


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


def visible_first(locator: Locator, timeout: int = 1500) -> Optional[Locator]:
    try:
        count = locator.count()
    except Exception:
        return None

    for index in range(count):
        item = locator.nth(index)
        try:
            if item.is_visible(timeout=timeout):
                return item
        except Exception:
            continue
    return None


def click_text(page: Page, pattern: str, timeout: int = 1500) -> bool:
    regex = re.compile(pattern, re.I)
    candidates = [
        page.get_by_role("button", name=regex),
        page.get_by_role("tab", name=regex),
        page.get_by_role("link", name=regex),
        page.locator(f"text=/{pattern}/i"),
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


def select_flow_mode(page: Page, media_type: str) -> None:
    if media_type == "image":
        click_text(page, r"Images?|Image|Create image|Generate image|Imagen|Nano")
    else:
        click_text(page, r"Videos?|Video|Create video|Generate video|Veo|Frames|Ingredients")


def upload_files(page: Page, files: List[str]) -> None:
    if not files:
        return

    inputs = page.locator('input[type="file"]')
    if inputs.count() == 0:
        click_text(page, r"Upload|Add media|Add image|Import|Reference|Ingredient|Frame|Tải|Thêm")
        page.wait_for_timeout(1000)
        inputs = page.locator('input[type="file"]')

    if inputs.count() == 0:
        raise RuntimeError("No file input found in Google Flow UI")

    target = inputs.nth(0)
    try:
        target.set_input_files(files)
    except Exception:
        for file_path in files:
            target.set_input_files(file_path)
            page.wait_for_timeout(700)
    page.wait_for_timeout(2500)


def fill_prompt(page: Page, prompt: str) -> None:
    textareas = page.locator("textarea")
    item = visible_first(textareas, 2500)
    if item:
        item.fill(prompt)
        return

    editable = visible_first(page.locator('[contenteditable="true"]'), 2500)
    if editable:
        editable.click()
        page.keyboard.press("Control+A")
        page.keyboard.type(prompt, delay=5)
        return

    text_input = visible_first(page.locator('input[type="text"]'), 2500)
    if text_input:
        text_input.fill(prompt)
        return

    raise RuntimeError("No prompt input found in Google Flow UI")


def click_generate(page: Page) -> None:
    clicked = click_text(page, r"Generate|Create|Submit|Send|Start|Make|Dream|Tạo|Sinh", 2500)
    if not clicked:
        page.keyboard.press("Control+Enter")
    page.wait_for_timeout(3000)


def try_download(page: Page, output_path: Path, timeout: int = 5000) -> bool:
    patterns = [
        r"Download|Export|Save|Tải xuống|Lưu",
        r"Open downloads?|More|Menu",
    ]

    for pattern in patterns:
        regex = re.compile(pattern, re.I)
        locators = [
            page.get_by_role("button", name=regex),
            page.get_by_role("link", name=regex),
            page.locator(f'text=/{pattern}/i'),
        ]

        for locator in locators:
            item = visible_first(locator, 1000)
            if not item:
                continue

            try:
                with page.expect_download(timeout=timeout) as download_info:
                    item.click(timeout=1500)
                download = download_info.value
                download.save_as(str(output_path))
                return output_path.exists() and output_path.stat().st_size > 0
            except Exception:
                continue

    return False


def fetch_src_from_browser(page: Page, src: str, output_path: Path) -> bool:
    if src.startswith("data:"):
        header, encoded = src.split(",", 1)
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


def largest_media_locator(page: Page, selector: str) -> Optional[Locator]:
    locator = page.locator(selector)
    best: Optional[Locator] = None
    best_area = 0.0

    for index in range(locator.count()):
        item = locator.nth(index)
        try:
            if not item.is_visible(timeout=500):
                continue
            box = item.bounding_box()
            if not box:
                continue
            area = float(box["width"]) * float(box["height"])
            if area > best_area:
                best_area = area
                best = item
        except Exception:
            continue

    return best


def save_media_from_page(page: Page, media_type: str, output_path: Path) -> None:
    if media_type == "video":
        page.wait_for_selector("video, video source", timeout=30 * 60 * 1000)
        media = largest_media_locator(page, "video") or page.locator("video source").first
        src = media.get_attribute("src")
        if not src and media.evaluate("el => el.currentSrc || ''"):
            src = media.evaluate("el => el.currentSrc || ''")
        if not src:
            raise RuntimeError("Generated video was visible but no src/currentSrc was found")
        fetch_src_from_browser(page, src, output_path)
        return

    page.wait_for_selector("img", timeout=10 * 60 * 1000)
    image = largest_media_locator(page, "img")
    if not image:
        raise RuntimeError("No generated image found")

    src = image.get_attribute("src")
    if src:
        try:
            if fetch_src_from_browser(page, src, output_path):
                return
        except Exception:
            pass

    image.screenshot(path=str(output_path))


def process_flow_job(page: Page, job: Dict[str, Any]) -> Path:
    media_type = str(job["type"])
    output_dir = Path(job["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)

    ext = "mp4" if media_type == "video" else "png"
    output_path = output_dir / result_filename(job, ext)
    upload_paths = prepare_upload_files(job)

    page.goto(str(job["flow_url"]), wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(3000)
    select_flow_mode(page, media_type)
    upload_files(page, upload_paths)
    fill_prompt(page, str(job["prompt"]))
    click_generate(page)

    wait_seconds = 45 if media_type == "image" else 90
    page.wait_for_timeout(wait_seconds * 1000)

    if try_download(page, output_path, timeout=8000):
        return output_path

    save_media_from_page(page, media_type, output_path)
    return output_path


def run_job(job: Dict[str, Any]) -> Dict[str, Any]:
    prompt_hash = hashlib.md5(str(job.get("prompt", "")).encode("utf-8")).hexdigest()
    profile = str(job.get("profile") or "default")

    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=get_profile_path(profile),
            headless=bool(job.get("headless")),
            channel="chrome",
            args=[
                "--disable-blink-features=AutomationControlled",
                "--start-maximized",
            ],
            ignore_default_args=["--enable-automation"],
            no_viewport=True if not job.get("headless") else False,
            accept_downloads=True,
            slow_mo=250,
        )

        try:
            page = context.pages[0] if context.pages else context.new_page()
            output_path = process_flow_job(page, job)
        finally:
            context.close()

    return {
        "status": "success",
        "type": job["type"],
        "result_url": public_url(job, output_path),
        "local_path": str(output_path),
        "prompt_hash": prompt_hash,
        "profile_used": profile,
    }


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
