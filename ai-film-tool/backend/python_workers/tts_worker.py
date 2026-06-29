import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

if sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')
if sys.stderr.encoding.lower() != 'utf-8':
    sys.stderr.reconfigure(encoding='utf-8')

try:
    import edge_tts
except ImportError:
    print(json.dumps({"error": "edge-tts not installed. Run: pip install edge-tts"}))
    sys.exit(1)


async def _generate_tts(text: str, voice: str, output_path: str, rate: str) -> None:
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    await communicate.save(output_path)


def generate_tts_sync(text: str, voice: str, output_path: str, rate: str = "-10%") -> None:
    asyncio.run(_generate_tts(text, voice, output_path, rate))


def run(job_path: str) -> None:
    with open(job_path, encoding="utf-8") as f:
        job = json.load(f)

    texts = job.get("texts", [])       # [{"text": "...", "index": 0}, ...]
    voice = job.get("voice", "vi-VN-HoaiMyNeural")
    out_dir = job["output_dir"]
    rate = job.get("rate", "-10%")     # Slightly slower for children

    os.makedirs(out_dir, exist_ok=True)
    print(f"[TTS] Generating {len(texts)} audio file(s) with voice={voice}, rate={rate}", file=sys.stderr)

    results = []
    for item in texts:
        idx = item["index"]
        text = (item.get("text") or "").strip()

        if not text:
            results.append({"index": idx, "audio_path": ""})
            print(f"[TTS] index={idx} — empty text, skipped", file=sys.stderr)
            continue

        out_path = os.path.join(out_dir, f"narration_{idx:03d}.mp3")
        try:
            generate_tts_sync(text, voice, out_path, rate)
            results.append({"index": idx, "audio_path": out_path})
            print(f"[TTS] index={idx} — OK: {out_path}", file=sys.stderr)
        except Exception as e:
            print(f"[TTS] index={idx} — ERROR: {e}", file=sys.stderr)
            results.append({"index": idx, "audio_path": "", "error": str(e)})

    print(json.dumps({"status": "success", "results": results}, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", type=str, required=True, help="Path to JSON job file")
    args = parser.parse_args()
    run(args.job)


if __name__ == "__main__":
    main()
