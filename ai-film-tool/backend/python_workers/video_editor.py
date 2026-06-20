import os
import sys
import json
import uuid
import ffmpeg
import argparse

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
        print(f"Error probing {video_path}: {e.stderr.decode('utf8', errors='ignore')}", file=sys.stderr)
        raise

def run(job_path):
    with open(job_path, 'r', encoding='utf-8') as f:
        job = json.load(f)
        
    video_urls = job.get('videoUrls', [])
    bgm_url = job.get('bgmUrl', '')
    auto_subtitles = job.get('auto_subtitles', False)
    output_path = job.get('output_path')
    
    if not video_urls:
        return {"status": "error", "message": "No video URLs provided."}
    if not output_path:
        return {"status": "error", "message": "No output path provided."}

    srt_path = os.path.join(os.path.dirname(job_path), f"sub-{uuid.uuid4().hex}.srt")
    temp_wav_path = os.path.join(os.path.dirname(job_path), f"audio-{uuid.uuid4().hex}.wav")
    
    has_subs = False
    
    def has_audio(path):
        try:
            probe = ffmpeg.probe(path)
            return any(stream['codec_type'] == 'audio' for stream in probe['streams'])
        except Exception:
            return False
    
    try:
        if auto_subtitles:
            # 1. Extract audio using concat filter
            audio_streams = []
            for vid in video_urls:
                in_file = ffmpeg.input(vid)
                if has_audio(vid):
                    audio_streams.append(in_file.audio.filter('aresample', 16000))
                else:
                    dur = get_duration(vid)
                    audio_streams.append(ffmpeg.input(f'anullsrc=r=16000:cl=mono', format='lavfi', t=dur).audio)
            
            if len(audio_streams) == 1:
                joined_audio = audio_streams[0]
            else:
                joined_audio = ffmpeg.concat(*audio_streams, v=0, a=1)
            ffmpeg.output(joined_audio, temp_wav_path, acodec='pcm_s16le', ac=1, ar=16000).run(overwrite_output=True, quiet=True)
            
            # 2. Run Whisper to transcribe
            import whisper
            from whisper.utils import get_writer
            
            print(json.dumps({"status": "processing", "message": "Loading Whisper model and transcribing..."}))
            # Đổi sang model 'medium' siêu xịn và lưu thẳng vào ổ D để không bị đầy ổ C
            models_dir = os.path.join(os.path.dirname(__file__), "whisper_models")
            os.makedirs(models_dir, exist_ok=True)
            model = whisper.load_model("medium", download_root=models_dir)
            result = model.transcribe(temp_wav_path, word_timestamps=True, language="vi")
            
            # 3. Write SRT file with TikTok-style short segments
            writer = get_writer("srt", os.path.dirname(temp_wav_path))
            writer_args = {
                "max_line_width": 30, 
                "max_line_count": 1, 
                "highlight_words": False
            }
            writer(result, temp_wav_path, writer_args)
            
            srt_path = temp_wav_path.replace(".wav", ".srt")
            if os.path.exists(srt_path):
                has_subs = True
                
        # Build filter graph for final video
        streams = []
        for vid in video_urls:
            in_file = ffmpeg.input(vid)
            # Normalize video to 1920x1080 30fps
            v = in_file.video.filter('scale', 1920, 1080, force_original_aspect_ratio='decrease') \
                             .filter('pad', 1920, 1080, '(ow-iw)/2', '(oh-ih)/2') \
                             .filter('setsar', 1) \
                             .filter('fps', fps=30, round='near')
            
            if has_audio(vid):
                a = in_file.audio.filter('aresample', 44100)
            else:
                dur = get_duration(vid)
                a = ffmpeg.input('anullsrc=r=44100:cl=stereo', format='lavfi', t=dur).audio
                
            streams.append(v)
            streams.append(a)

        if len(video_urls) == 1:
            v_stream = streams[0]
            a_stream = streams[1]
        else:
            joined = ffmpeg.concat(*streams, v=1, a=1)
            v_stream = joined.video
            a_stream = joined.audio
        
        if has_subs:
            rel_srt = os.path.relpath(srt_path).replace('\\', '/')
            # Adding black outline for better visibility
            style = "Fontsize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1"
            v_stream = v_stream.filter('subtitles', rel_srt, force_style=style)
            
        if bgm_url:
            bgm = ffmpeg.input(bgm_url).audio.filter('volume', '0.3').filter('aresample', 44100)
            a_stream = ffmpeg.filter([a_stream, bgm], 'amix', inputs=2, duration='first')
            
        out = ffmpeg.output(v_stream, a_stream, output_path, vcodec='libx264', acodec='aac', pix_fmt='yuv420p', movflags='+faststart')
        out.run(overwrite_output=True, capture_stdout=True, capture_stderr=True)
        
        return {"status": "success", "local_path": output_path}
        
    except ffmpeg.Error as e:
        stderr_msg = e.stderr.decode('utf8', errors='ignore') if e.stderr else "Unknown ffmpeg error"
        return {"status": "error", "message": stderr_msg}
    finally:
        # Cleanup
        if os.path.exists(srt_path):
            os.remove(srt_path)
        if os.path.exists(temp_wav_path):
            os.remove(temp_wav_path)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--job', type=str, required=True, help="Path to the JSON job file")
    args = parser.parse_args()
    
    try:
        result = run(args.job)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))
