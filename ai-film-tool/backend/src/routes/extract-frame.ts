import { Router, type Request, type Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const router = Router();

router.post('/', (req: Request, res: Response): void => {
  const { videoUrl } = req.body;

  if (!videoUrl) {
    res.status(400).json({ error: 'videoUrl is required' });
    return;
  }

  try {
    const videoFileName = videoUrl.split('/').pop() || '';
    const videoPath = path.join(process.cwd(), 'generated', videoFileName);
    
    if (!fs.existsSync(videoPath)) {
      res.status(404).json({ error: 'Video file not found locally' });
      return;
    }

    const frameFileName = videoFileName.replace(/\.[^/.]+$/, "") + "_last_frame.jpg";
    const framePath = path.join(process.cwd(), 'generated', frameFileName);

    // Cách lấy frame cuối robust nhất cho video ngắn (4-8s):
    // Decode toàn bộ video và ghi đè liên tục lên file ảnh (update 1).
    // Khi video kết thúc, file ảnh sẽ chứa frame cuối cùng. 
    // Tránh được lỗi timecode hoặc header hỏng của sseof.
    const ffmpegCmd = 'ffmpeg';
    const args = [
      '-y', 
      '-i', videoPath,
      '-update', '1',
      '-q:v', '2',
      framePath
    ];

    const child = spawn(ffmpegCmd, args);

    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error('[Extract Frame] ffmpeg error:', stderr);
        return res.status(500).json({ error: 'Failed to extract frame', details: stderr });
      }

      if (fs.existsSync(framePath)) {
        const resultUrl = videoUrl.replace(videoFileName, frameFileName);
        res.json({ status: 'success', result_url: resultUrl, local_path: framePath });
      } else {
        res.status(500).json({ error: 'Frame extracted but file not found' });
      }
    });

  } catch (err: any) {
    console.error('[Extract Frame] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
