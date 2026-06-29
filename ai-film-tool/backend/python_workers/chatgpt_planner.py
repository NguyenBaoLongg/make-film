import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

if sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')
if sys.stderr.encoding.lower() != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8')

ROOT_DIR = Path(__file__).resolve().parent.parent
PROFILES_DIR = ROOT_DIR / "chrome_profiles"

def send_and_get_json(page, prompt_text: str):
    print("[ChatGPT] Inserting prompt...", file=sys.stderr)
    
    # Check if we need to start a new chat (only for the very first message if somehow stuck)
    # but normally we want to continue in the same chat.
    
    textarea = page.locator("#prompt-textarea, [contenteditable='true']").first
    textarea.wait_for(state="visible", timeout=15000)
    textarea.click()
    
    # Xóa chữ cũ và dán chữ mới
    page.keyboard.press("Control+A")
    page.keyboard.press("Backspace")
    page.keyboard.insert_text(prompt_text)
    page.wait_for_timeout(1000)
    
    # Ấn nút Gửi
    send_btn = page.locator('[data-testid="send-button"], button[aria-label="Send"]').first
    if send_btn.is_visible():
        send_btn.click()
    else:
        page.keyboard.press("Enter")
        
    print("[ChatGPT] Prompt sent. Waiting for response...", file=sys.stderr)
    # 3. Đợi nút Stop biến mất (ChatGPT viết xong)
    page.wait_for_timeout(5000)
    for _ in range(60): # Đợi tối đa 5 phút
        stop_btn = page.locator('[data-testid="stop-button"], button[aria-label*="Stop"]')
        
        # Kiểm tra xem có nút Stop nào đang hiển thị không
        is_generating = False
        if stop_btn.count() > 0:
            for i in range(stop_btn.count()):
                if stop_btn.nth(i).is_visible():
                    is_generating = True
                    break
                    
        if is_generating:
            page.wait_for_timeout(5000)
            print("[ChatGPT] Still generating...", file=sys.stderr)
        else:
            page.wait_for_timeout(1000)
            send_btn = page.locator('[data-testid="send-button"], button[aria-label="Send"]')
            if send_btn.count() > 0 and send_btn.first.is_enabled():
                break
            elif send_btn.count() == 0:
                # Nếu không tìm thấy send_btn (có thể đổi UI), thì break dựa vào việc không còn nút stop
                break
                
    page.wait_for_timeout(2000)
    
    print("[ChatGPT] Extracting response...", file=sys.stderr)
    messages = page.locator('div[data-message-author-role="assistant"]')
    if messages.count() == 0:
        raise RuntimeError("No response found from ChatGPT.")
        
    raw_text = messages.last.inner_text().strip()
    
    try:
        # Gọt bỏ khung Markdown
        clean_text = re.sub(r'^```(?:json)?\s*', '', raw_text, flags=re.MULTILINE)
        clean_text = re.sub(r'\s*```\s*$', '', clean_text, flags=re.MULTILINE)
        clean_text = clean_text.strip()
        
        # Nhổ chính xác khối JSON
        match = re.search(r'\{.*\}', clean_text, re.DOTALL)
        if match:
            clean_text = match.group(0)
                
        parsed_data = json.loads(clean_text)
        
        # Post-process: Replace @@@ with standard double quotes (") for Veo 3 dialogue
        # This bypasses JSON escaping issues during LLM generation.
        if isinstance(parsed_data, dict):
            if "shots" in parsed_data:
                for shot in parsed_data["shots"]:
                    if "video_prompt" in shot and isinstance(shot["video_prompt"], str):
                        shot["video_prompt"] = shot["video_prompt"].replace("@@@", '"')
            elif "scenes" in parsed_data:
                for scene in parsed_data["scenes"]:
                    if "shots" in scene:
                        for shot in scene["shots"]:
                            if "video_prompt" in shot and isinstance(shot["video_prompt"], str):
                                shot["video_prompt"] = shot["video_prompt"].replace("@@@", '"')
                                
        return parsed_data
    except Exception as e:
        print(f"[ChatGPT] Error parsing JSON: {e}", file=sys.stderr)
        print(f"[ChatGPT] RAW TEXT DUMP:\n{raw_text}", file=sys.stderr)
        try:
            err_shot = os.path.join(ROOT_DIR, "tmp", f"chatgpt_err_{int(time.time())}.png")
            page.screenshot(path=err_shot)
            print(f"[ChatGPT] Error screenshot saved to {err_shot}", file=sys.stderr)
        except:
            pass
        raise RuntimeError("Could not parse JSON from ChatGPT response. The response might be malformed.")

def generate_film_plan(idea: str, settings: dict, profile_name: str, headless: bool):
    profile_dir_path = str(PROFILES_DIR / profile_name)
    
    with sync_playwright() as p:
        print(f"[ChatGPT] Launching Chrome with profile: {profile_dir_path}", file=sys.stderr)
        try:
            context = p.chromium.launch_persistent_context(
                user_data_dir=profile_dir_path,
                headless=headless,
                channel="chrome",
                args=[
                    '--start-maximized',
                    '--disable-blink-features=AutomationControlled'
                ],
                ignore_default_args=['--enable-automation'],
                no_viewport=True,
                timeout=30000
            )
        except Exception as e:
            raise RuntimeError("Failed to launch Chrome. Profile might be locked by another Chrome instance. Please close all Chrome windows and try again. Error: " + str(e))
        
        page = context.pages[0] if context.pages else context.new_page()
        try:
            page.goto("https://chatgpt.com/", timeout=60000, wait_until="domcontentloaded")
        except Exception as e:
            print(f"[ChatGPT] Warning during page load: {e}", file=sys.stderr)
            
        page.wait_for_timeout(5000)
        
        # Click "New chat" if it's there, to ensure a fresh context
        try:
            new_chat_btn = page.locator('a[href="/"], button:has-text("New chat")').first
            if new_chat_btn.is_visible(timeout=5000):
                new_chat_btn.click(timeout=5000)
                page.wait_for_timeout(2000)
        except Exception as e:
            print(f"[ChatGPT] Could not click New Chat: {e}", file=sys.stderr)
        
        # Lấy style từ settings (videoStyle fallback về image style nếu không có)
        image_style = settings.get('style', '')
        video_style = settings.get('videoStyle', image_style)

        # Step 1: Film Bible
        print("[ChatGPT] Step 1/5: Generating Film Bible...", file=sys.stderr)
        p1 = f"""You are an expert AI film director. We are creating an AI film plan step by step.
Step 1: Create only the Film Bible for this idea.
Return compact valid JSON only with this exact schema:
{{
  "project": {{
    "title": "",
    "target_duration_seconds": {settings.get('duration', 60)},
    "film_bible": {{
      "genre": "",
      "theme": "",
      "tone": "",
      "visual_style": "{image_style}",
      "video_style": "{video_style}",
      "color_palette": []
    }}
  }}
}}
Do not include characters or shots yet.

Idea:
{idea}"""
        bible_res = send_and_get_json(page, p1)

        # Step 2: Characters
        print("[ChatGPT] Step 2/5: Generating Characters...", file=sys.stderr)
        p2 = f"""Using this Film Bible, create only the Character Library.
Each character must include: id, name, identity_lock, reference_image_prompt, negative_prompt.
CRITICAL: Every reference_image_prompt MUST end with: "{image_style}"
Return valid JSON only: {{ "characters": [ ... ] }}"""
        char_res = send_and_get_json(page, p2)

        # Step 3: Locations
        print("[ChatGPT] Step 3/5: Generating Locations...", file=sys.stderr)
        p3 = f"""Using this Film Bible, create only the Location Library.
Each location must include: id, name, continuity_lock, reference_image_prompt, negative_prompt, empty_environment (true/false).
Location prompts MUST include "Environment reference only. No characters. No real humans. No random people."
CRITICAL: Every reference_image_prompt MUST end with: "{image_style}"
Return valid JSON only: {{ "locations": [ ... ] }}"""
        loc_res = send_and_get_json(page, p3)

        # Step 4: Scene Outline
        print("[ChatGPT] Step 4/5: Generating Scene Outline...", file=sys.stderr)
        p4 = """Create only the scene outline.
Do not write image prompts or video prompts yet.
Return valid JSON only: { "scenes": [ { "id": "scene_1", "title": "", "duration": 10, "characters": ["char_1"], "location": "loc_1" } ] }"""
        outline_res = send_and_get_json(page, p4)

        # Step 5+: Shots
        print("[ChatGPT] Step 5/5: Generating Shots for scenes...", file=sys.stderr)
        scenes_data = outline_res.get("scenes", [])
        final_scenes = []
        for scene in scenes_data:
            scene_id = scene.get("id")
            print(f"[ChatGPT] Generating shots for {scene_id}...", file=sys.stderr)
            p5 = f"""Create shots only for scene {scene_id}.
Each shot must include: id, duration_seconds, reference_ids (list of char/loc ids), image_prompt, video_prompt, dialogue_vi, voiceover_vi, subtitle_vi.

CRITICAL JSON FORMATTING RULE:
- NEVER use double quotes (") inside any JSON string value. If you need to quote a phrase, use single quotes ('). Unescaped double quotes will break the JSON parser.

CRITICAL STORYTELLING RULES:
- The script MUST be highly detailed and cinematic. Do not write simple actions. 
- Describe complex character movements, emotional facial expressions, and dynamic camera angles (e.g., Close-up, Tracking shot, Low angle).
- If characters speak, write natural, compelling Vietnamese dialogue in `dialogue_vi`. 
- Ensure the scene has a clear narrative flow.

CRITICAL STYLE RULES - apply to every single shot without exception:
1. Every image_prompt MUST end with this exact suffix: "{image_style}"
2. Every video_prompt MUST:
   - Begin with: "Use the provided image as the exact mandatory first frame."
   - End with: "Maintain {video_style} throughout."
   - Explicitly state: "No background music. Keep ambient sound and foley/SFX for character actions."
   - IF the shot contains `dialogue_vi`, you MUST explicitly append these exact Veo 3 keywords to the video_prompt: "The character is speaking dialogue. Natural conversational acting, highly expressive facial expressions, lips and mouth moving naturally in sync with speech. The character speaks clearly in Vietnamese: @@@[INSERT THE EXACT DIALOGUE_VI TEXT HERE]@@@ . Ensure the generated video includes clear spoken Vietnamese audio for this dialogue."

Return valid JSON only: {{ "id": "{scene_id}", "shots": [ ... ] }}"""
            shots_res = send_and_get_json(page, p5)
            scene_final = {
                "id": scene_id,
                "shots": shots_res.get("shots", [])
            }
            final_scenes.append(scene_final)
            
        context.close()
        
        # Merge Plan
        final_plan = {
            "version": "1.0",
            "project": bible_res.get("project", {}),
            "characters": char_res.get("characters", []),
            "locations": loc_res.get("locations", []),
            "scenes": final_scenes
        }
        
        # Ensure film_bible is set correctly for parsing later
        if "film_bible" not in final_plan:
             final_plan["film_bible"] = final_plan.get("project", {}).get("film_bible", {})
             
        return final_plan

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", type=str, required=True, help="Path to JSON job file")
    args = parser.parse_args()

    with open(args.job, "r", encoding="utf-8") as f:
        job = json.load(f)

    idea = job.get("idea")
    settings = job.get("settings", {})
    profile = job.get("profile", "default")
    headless = job.get("headless", False)

    if not idea:
        # Fallback for old prompt-based payload if needed
        if job.get("prompt"):
            print(json.dumps({"error": "Payload is using old 'prompt' format. Please use 'idea' and 'settings' format."}))
            sys.exit(1)
            
        print(json.dumps({"error": "No idea provided in job."}))
        sys.exit(1)

    try:
        result = generate_film_plan(idea, settings, profile, headless)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)

if __name__ == "__main__":
    main()
