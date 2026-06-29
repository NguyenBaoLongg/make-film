import os
import sys
import json
import uuid
import ffmpeg
import argparse
import tempfile
import urllib.request
import urllib.error

def format_time(seconds):
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"

def get_duration(video_path):
    try:
        probe = ffmpeg.probe(video_path)
        return float(probe['format']['duration'])
    except ffmpeg.Error as e:
        stderr_text = e.stderr.decode('utf8', errors='ignore') if e.stderr else 'unknown'
        print(f"Error probing {video_path}: {stderr_text}", file=sys.stderr)
        raise

def escape_drawtext(text):
    """
    Escape text cho FFmpeg drawtext filter.
    FFmpeg drawtext cần escape: ' : \\ ; [ ] { }
    Theo tài liệu ffmpeg, trong drawtext, dùng cú pháp escape 2 lớp:
    - Level 1 (ffmpeg filter): \\ -> \\\\, ' -> \\', : -> \\:
    - Level 2 (drawtext): tất cả special chars cần \\
    
    Với ffmpeg-python, nó tự handle 1 lớp escape, nên ta chỉ cần escape
    cho drawtext level: ' -> '', : -> \\:, \\ -> \\\\
    """
    # ffmpeg-python sẽ tự wrap argument, nên ta chỉ cần escape cho drawtext parser
    result = text
    result = result.replace('\\', '\\\\')       # \ -> \\
    result = result.replace("'", "'\\\\\\''")   # ' -> escaped form
    result = result.replace(':', '\\:')         # : -> \:
    result = result.replace(';', '\\;')         # ; -> \;
    result = result.replace('%', '%%')          # % -> %% (drawtext dùng % cho time format)
    return result

def escape_subtitle_path(abs_path):
    """
    Escape đường dẫn file SRT cho subtitles filter trên Windows.
    FFmpeg subtitles filter dùng libass, cần:
    - Dùng forward slash thay backslash
    - Dùng relative path để tránh lỗi ffmpeg-python escape dấu : của ổ đĩa
    - Escape dấu [ ] thành \\[ \\]
    """
    # Đưa file ra ngoài root dir (cwd) và chỉ truyền tên file.
    # FFmpeg subtitles filter trên Windows cực kỳ lỗi với absolute path qua ffmpeg-python
    # Cách tốt nhất: copy file ra cwd, và chỉ đưa tên file (vd: "sub-123.srt")
    import shutil
    basename = os.path.basename(abs_path)
    cwd_path = os.path.join(os.getcwd(), basename)
    if abs_path != cwd_path and os.path.exists(abs_path):
        shutil.copy2(abs_path, cwd_path)
    
    # Trả về chỉ mỗi tên file, không có slashes hay colons để libass khỏi nhầm lẫn
    return basename

def find_font():
    """
    Tìm font hỗ trợ tiếng Việt, thử nhiều font phổ biến trên Windows.
    Trả về path đầu tiên tồn tại, hoặc None.
    """
    candidates = [
        "C:/Windows/Fonts/arialbd.ttf",     # Arial Bold
        "C:/Windows/Fonts/arial.ttf",        # Arial
        "C:/Windows/Fonts/segoeui.ttf",      # Segoe UI
        "C:/Windows/Fonts/tahoma.ttf",       # Tahoma
        "C:/Windows/Fonts/verdana.ttf",      # Verdana
        "C:/Windows/Fonts/calibri.ttf",      # Calibri
        "C:/Windows/Fonts/times.ttf",        # Times New Roman
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None

def download_to_temp(url, suffix='.audio', temp_dir=None):
    """
    Tải file từ URL HTTP/HTTPS về file tạm.
    Trả về đường dẫn file tạm, hoặc None nếu thất bại.
    """
    try:
        print(f"Downloading BGM: {url}", file=sys.stderr)
        # Tạo file tạm trong cùng thư mục temp_dir
        fd, temp_path = tempfile.mkstemp(suffix=suffix, dir=temp_dir)
        os.close(fd)
        
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) video-editor/1.0'
        })
        with urllib.request.urlopen(req, timeout=60) as response:
            with open(temp_path, 'wb') as out_file:
                while True:
                    chunk = response.read(8192)
                    if not chunk:
                        break
                    out_file.write(chunk)
        
        file_size = os.path.getsize(temp_path)
        print(f"BGM downloaded: {file_size} bytes -> {temp_path}", file=sys.stderr)
        
        if file_size == 0:
            os.remove(temp_path)
            return None
            
        return temp_path
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        print(f"Warning: Could not download BGM from {url}: {e}", file=sys.stderr)
        if 'temp_path' in locals() and os.path.exists(temp_path):
            os.remove(temp_path)
        return None

def has_audio(path):
    """Kiểm tra file video có audio stream hay không."""
    try:
        probe = ffmpeg.probe(path)
        return any(stream.get('codec_type') == 'audio' for stream in probe.get('streams', []))
    except Exception:
        return False

def run(job_path):
    with open(job_path, 'r', encoding='utf-8') as f:
        job = json.load(f)

    video_urls = job.get('videoUrls', [])
    bgm_url = job.get('bgmUrl', '')
    video_title = str(job.get('videoTitle') or '').strip()
    auto_subtitles = job.get('auto_subtitles', False)
    output_path = job.get('output_path')
    # narration_paths: list of {index: int, audio_path: str} — one per scene
    narration_paths_raw = job.get('narration_paths', [])
    narration_by_index = {
        int(item['index']): item['audio_path']
        for item in narration_paths_raw
        if item.get('audio_path') and os.path.isfile(item['audio_path'])
    }
    
    if not video_urls:
        return {"status": "error", "message": "No video URLs provided."}
    if not output_path:
        return {"status": "error", "message": "No output path provided."}

    # Kiểm tra tất cả video input tồn tại
    for vid in video_urls:
        if not os.path.isfile(vid):
            return {"status": "error", "message": f"Video file not found: {vid}"}

    temp_dir = os.path.dirname(job_path)
    srt_path = os.path.join(temp_dir, f"sub-{uuid.uuid4().hex}.srt")
    temp_wav_path = os.path.join(temp_dir, f"audio-{uuid.uuid4().hex}.wav")
    temp_bgm_path = None  # Sẽ set nếu download BGM từ URL
    temp_title_path = None
    
    has_subs = False
    
    try:
        # === BƯỚC 0: Xử lý BGM URL (download nếu là HTTP) ===
        resolved_bgm_path = ''
        if bgm_url:
            if bgm_url.startswith('http://') or bgm_url.startswith('https://'):
                # Download về local để tránh lỗi SSL/redirect/protocol
                temp_bgm_path = download_to_temp(bgm_url, suffix='.ogg', temp_dir=temp_dir)
                if temp_bgm_path:
                    resolved_bgm_path = temp_bgm_path
                else:
                    print(f"Warning: BGM download failed, sẽ bỏ qua nhạc nền.", file=sys.stderr)
            elif os.path.isfile(bgm_url):
                resolved_bgm_path = bgm_url
            else:
                print(f"Warning: BGM file not found: {bgm_url}, sẽ bỏ qua.", file=sys.stderr)
        
        # === BƯỚC 1: Tạo phụ đề tự động (Whisper) ===
        # Extract audio per-video into separate WAV files, then concat using the concat demuxer.
        # This avoids ffmpeg-python filter graph "multiple outgoing edges" errors.
        if auto_subtitles:
            print("Extracting audio for subtitle generation...", file=sys.stderr)
            seg_audio_paths = []
            extract_ok = True

            for i, vid in enumerate(video_urls):
                seg_path = os.path.join(temp_dir, f"whisper_seg_{i}_{uuid.uuid4().hex}.wav")
                try:
                    if has_audio(vid):
                        (ffmpeg.input(vid).audio
                            .filter('aresample', 16000)
                            .output(seg_path, acodec='pcm_s16le', ac=1, ar=16000)
                            .run(overwrite_output=True, quiet=True))
                    else:
                        dur = get_duration(vid)
                        (ffmpeg.input('anullsrc=r=16000:cl=mono', format='lavfi', t=str(dur)).audio
                            .output(seg_path, acodec='pcm_s16le', ac=1, ar=16000)
                            .run(overwrite_output=True, quiet=True))
                    seg_audio_paths.append(seg_path)
                except Exception as e:
                    print(f"Warning: Failed to extract audio segment {i}: {e}", file=sys.stderr)
                    extract_ok = False
                    break

            if extract_ok and seg_audio_paths:
                try:
                    if len(seg_audio_paths) == 1:
                        import shutil as _shutil
                        _shutil.move(seg_audio_paths[0], temp_wav_path)
                        seg_audio_paths = []
                    else:
                        # Build concat list file (demuxer approach — no filter graph)
                        list_file = os.path.join(temp_dir, f"whisper_list_{uuid.uuid4().hex}.txt")
                        with open(list_file, 'w', encoding='utf-8') as lf:
                            for p in seg_audio_paths:
                                safe_p = os.path.abspath(p).replace('\\', '/')
                                lf.write(f"file '{safe_p}'\n")
                        try:
                            (ffmpeg.input(list_file, format='concat', safe=0).audio
                                .output(temp_wav_path, acodec='pcm_s16le', ac=1, ar=16000)
                                .run(overwrite_output=True, quiet=True))
                        finally:
                            if os.path.exists(list_file):
                                os.remove(list_file)
                except Exception as e:
                    print(f"Warning: Failed to join audio segments: {e}", file=sys.stderr)
                    extract_ok = False
                finally:
                    for p in seg_audio_paths:
                        if p and os.path.exists(p):
                            try:
                                os.remove(p)
                            except OSError:
                                pass

            if not extract_ok:
                auto_subtitles = False
        
        if auto_subtitles and os.path.isfile(temp_wav_path):
            try:
                import whisper
                from whisper.utils import get_writer
                
                print("Loading Whisper model and transcribing...", file=sys.stderr)
                # Lưu model vào ổ D để không bị đầy ổ C
                models_dir = os.path.join(os.path.dirname(__file__), "whisper_models")
                os.makedirs(models_dir, exist_ok=True)
                model = whisper.load_model("medium", download_root=models_dir)
                result = model.transcribe(temp_wav_path, word_timestamps=True, language="vi")
                
                # Write SRT file with TikTok-style short segments
                writer = get_writer("srt", os.path.dirname(temp_wav_path))
                writer_args = {
                    "max_line_width": 30, 
                    "max_line_count": 1, 
                    "highlight_words": False
                }
                writer(result, temp_wav_path, writer_args)
                
                srt_path = temp_wav_path.replace(".wav", ".srt")
                if os.path.exists(srt_path):
                    # Kiểm tra xem file có chứa phụ đề hợp lệ không (tránh lỗi file rỗng do video không có tiếng)
                    with open(srt_path, 'r', encoding='utf-8', errors='ignore') as f:
                        srt_content = f.read()
                    
                    if '-->' in srt_content:
                        has_subs = True
                        print(f"Subtitles generated: {srt_path}", file=sys.stderr)
                    else:
                        print(f"Subtitles file is empty (silent video), skipping.", file=sys.stderr)
                        has_subs = False
            except ImportError:
                print("Warning: Whisper not installed, skipping subtitles.", file=sys.stderr)
            except Exception as e:
                print(f"Warning: Whisper transcription failed: {e}, skipping subtitles.", file=sys.stderr)
                
        # === BƯỚC 2: Probe resolution từ video đầu tiên ===
        target_width, target_height = 1920, 1080
        try:
            probe = ffmpeg.probe(video_urls[0])
            for stream in probe.get('streams', []):
                if stream.get('codec_type') == 'video':
                    target_width = int(stream['width'])
                    target_height = int(stream['height'])
                    break
        except Exception as e:
            print(f"Warning: Could not probe resolution, using default {target_width}x{target_height}: {e}", file=sys.stderr)

        # === BƯỚC 3: Build filter graph ===
        print(f"Building filter graph: {len(video_urls)} video(s), target={target_width}x{target_height}", file=sys.stderr)
        
        v_inputs = []
        a_inputs = []
        for scene_idx, vid in enumerate(video_urls):
            # Thêm probesize khác nhau để trick ffmpeg-python không deduplicate các input trùng lặp
            in_file = ffmpeg.input(vid, probesize=5000000 + scene_idx)
            # Normalize video to target resolution and 30fps
            v = in_file.video \
                .filter('scale', target_width, target_height, force_original_aspect_ratio='decrease') \
                .filter('pad', target_width, target_height, '(ow-iw)/2', '(oh-ih)/2') \
                .filter('setsar', 1) \
                .filter('fps', fps=30, round='near') \
                .filter('format', 'yuv420p')

            dur = get_duration(vid)
            if has_audio(vid):
                ambient = in_file.audio.filter('aformat', sample_rates='44100', channel_layouts='stereo')
            else:
                ambient = ffmpeg.input('anullsrc=r=44100:cl=stereo', format='lavfi', t=str(dur)).audio

            narration_path = narration_by_index.get(scene_idx)
            if narration_path:
                print(f"[VideoEditor] Scene {scene_idx}: mixing narration {narration_path}", file=sys.stderr)
                # Duck ambient to 20%, narration at 100%, pad narration to scene duration
                narration_audio = ffmpeg.input(narration_path).audio \
                    .filter('aformat', sample_rates='44100', channel_layouts='stereo') \
                    .filter('apad', whole_dur=str(dur))
                ambient_ducked = ambient.filter('volume', '0.2')
                a = ffmpeg.filter([ambient_ducked, narration_audio], 'amix', inputs=2, duration='first')
            else:
                a = ambient

            v_inputs.append(v)
            a_inputs.append(a)

        if len(video_urls) == 1:
            v_stream = v_inputs[0]
            a_stream = a_inputs[0]
        else:
            # Tách riêng concat video và audio để tránh lỗi ffmpeg-python "multiple outgoing edges"
            v_stream = ffmpeg.concat(*v_inputs, v=1, a=0)
            a_stream = ffmpeg.concat(*a_inputs, v=0, a=1)
        
        # === BƯỚC 4: Thêm subtitles ===
        if has_subs:
            # Dùng absolute path và escape đúng cách cho Windows
            abs_srt = os.path.abspath(srt_path)
            escaped_srt = escape_subtitle_path(abs_srt)
            # Adding black outline for better visibility, smaller font for 9:16 vertical videos
            style = "Fontsize=13,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1"
            try:
                v_stream = v_stream.filter('subtitles', escaped_srt, force_style=style)
                print(f"Subtitles filter added: {escaped_srt}", file=sys.stderr)
            except Exception as e:
                print(f"Warning: Failed to add subtitles filter: {e}", file=sys.stderr)
            
        # === BƯỚC 5: Thêm drawtext overlay (TẬP PHIM + title) ===
        font_path = find_font()
        if font_path:
            print(f"Using font: {font_path}", file=sys.stderr)
            
            # Line 1: TẬP PHIM (text đơn giản, không có ký tự đặc biệt)
            v_stream = v_stream.filter(
                'drawtext',
                text=escape_drawtext('TẬP PHIM'),
                fontfile=font_path,
                fontcolor='white',
                fontsize=60,
                bordercolor='black',
                borderw=4,
                x='(w-text_w)/2',
                y='h/6',
                enable='between(t,0,5)'
            )
            
            # Dòng phân cách màu cam ở GIỮA 2 DÒNG
            v_stream = v_stream.filter(
                'drawbox',
                x='(iw-300)/2',
                y='ih/6+90',
                width=300,
                height=8,
                color='#FFB000',
                t='fill',
                enable='between(t,0,5)'
            )
            
            # Line 2: Actual Title (Tên tập phim thực tế)
            if video_title:
                temp_title_path = os.path.join(temp_dir, f"title-{uuid.uuid4().hex}.txt")
                with open(temp_title_path, 'w', encoding='utf-8') as f:
                    f.write(video_title.upper())
                
                # FFmpeg textfile path on Windows needs proper formatting
                # Using relative path with forward slashes bypasses drive letter escaping issues
                rel_textfile = os.path.relpath(temp_title_path, os.getcwd()).replace('\\', '/')
                
                print(f"Adding title overlay via textfile: {video_title} -> {rel_textfile}", file=sys.stderr)
                v_stream = v_stream.filter(
                    'drawtext',
                    textfile=rel_textfile,
                    fontfile=font_path,
                    fontcolor='white',
                    fontsize=35,
                    bordercolor='black',
                    borderw=3,
                    x='(w-text_w)/2',
                    y='h/6+110',
                    enable='between(t,0,5)'
                )
        else:
            print("Warning: No suitable font found, skipping text overlay.", file=sys.stderr)
            
        # === BƯỚC 6: Mix nhạc nền (BGM) ===
        if resolved_bgm_path:
            try:
                print(f"Mixing BGM: {resolved_bgm_path}", file=sys.stderr)
                bgm = ffmpeg.input(resolved_bgm_path).audio \
                    .filter('volume', '0.3') \
                    .filter('aformat', sample_rates='44100', channel_layouts='stereo')
                a_stream = ffmpeg.filter([a_stream, bgm], 'amix', inputs=2, duration='first')
            except Exception as e:
                print(f"Warning: Failed to mix BGM: {e}, continuing without background music.", file=sys.stderr)
            
        # === BƯỚC 7: Render output ===
        print(f"Rendering final video: {output_path}", file=sys.stderr)
        out = ffmpeg.output(
            v_stream, a_stream, output_path,
            vcodec='libx264',
            acodec='aac',
            pix_fmt='yuv420p',
            movflags='+faststart'
        )
        
        # In ra ffmpeg command để debug nếu cần
        cmd = out.compile()
        print(f"FFmpeg command: {' '.join(cmd)}", file=sys.stderr)
        
        out.run(overwrite_output=True, capture_stdout=True, capture_stderr=True)
        
        # Verify output
        if not os.path.isfile(output_path):
            return {"status": "error", "message": "FFmpeg completed but output file was not created."}
        
        output_size = os.path.getsize(output_path)
        if output_size == 0:
            return {"status": "error", "message": "FFmpeg created an empty output file."}
            
        print(f"Render completed: {output_path} ({output_size} bytes)", file=sys.stderr)
        return {"status": "success", "local_path": output_path}
        
    except ffmpeg.Error as e:
        stderr_msg = "Unknown ffmpeg error"
        if e.stderr:
            stderr_msg = e.stderr.decode('utf8', errors='ignore')
        elif e.stdout:
            stderr_msg = e.stdout.decode('utf8', errors='ignore')
        print(f"FFmpeg Error: {stderr_msg}", file=sys.stderr)
        return {"status": "error", "message": f"FFmpeg failed: {stderr_msg[-2000:]}"}
    except Exception as e:
        # Bắt mọi exception khác (FileNotFoundError, PermissionError, etc.)
        print(f"Unexpected error: {type(e).__name__}: {e}", file=sys.stderr)
        return {"status": "error", "message": f"{type(e).__name__}: {e}"}
    finally:
        # Cleanup tất cả temp files
        for temp_file in [srt_path, temp_wav_path, temp_bgm_path, temp_title_path]:
            if temp_file and os.path.exists(temp_file):
                try:
                    os.remove(temp_file)
                except OSError:
                    pass
        
        # Cleanup cả file SRT ở root nếu có copy
        if srt_path:
            root_srt = os.path.join(os.getcwd(), os.path.basename(srt_path))
            if os.path.exists(root_srt):
                try:
                    os.remove(root_srt)
                except OSError:
                    pass

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--job', type=str, required=True, help="Path to the JSON job file")
    args = parser.parse_args()
    
    try:
        result = run(args.job)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))
