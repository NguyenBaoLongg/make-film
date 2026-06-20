import os
import sys
import json

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from python_workers.video_editor import run

def main():
    sys.stdout.reconfigure(encoding='utf-8')
    vid_path = r"D:\workspace\Python\App\make film\ai-film-tool\backend\generated\FILM_final_1781840059849.mp4"
    
    if not os.path.exists(vid_path):
        print(f"Không tìm thấy file: {vid_path}")
        return

    job_path = os.path.join(os.path.dirname(__file__), "fix_job.json")
    out_path = r"D:\workspace\Python\App\make film\ai-film-tool\backend\generated\FILM_final_1781840059849_PERFECT_SUB.mp4"
    
    job_data = {
        "videoUrls": [vid_path],
        "bgmUrl": "",
        "auto_subtitles": True,
        "output_path": out_path
    }
    
    with open(job_path, 'w', encoding='utf-8') as f:
        json.dump(job_data, f, indent=2)
        
    print("Đang chạy Whisper Medium (dùng ổ D) để xuất phụ đề chính xác 100%...")
    result = run(job_path)
    
    print("\n--- KẾT QUẢ ---")
    print(json.dumps(result, indent=2, ensure_ascii=False))
    
    if os.path.exists(job_path):
        os.remove(job_path)

if __name__ == "__main__":
    main()
