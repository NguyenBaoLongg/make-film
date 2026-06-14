import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const router = Router();

// Đường dẫn Python và script
const isWindows = process.platform === 'win32';
const pythonExe = isWindows
  ? path.join(__dirname, '../../venv/Scripts/python.exe')
  : path.join(__dirname, '../../venv/bin/python');
const chromeManagerScript = path.join(__dirname, '../../python_workers/chrome_manager.py');
const profilesDir = path.join(__dirname, '../../chrome_profiles');

/**
 * GET /api/chrome/profiles
 * Liệt kê tất cả Chrome profiles đã tạo
 */
router.get('/profiles', (req, res) => {
  try {
    if (!fs.existsSync(profilesDir)) {
      fs.mkdirSync(profilesDir, { recursive: true });
    }
    
    const profiles = fs.readdirSync(profilesDir)
      .filter(name => {
        const fullPath = path.join(profilesDir, name);
        return fs.statSync(fullPath).isDirectory();
      })
      .map(name => {
        const fullPath = path.join(profilesDir, name);
        const defaultPath = path.join(fullPath, 'Default');
        const hasSession = fs.existsSync(defaultPath);
        return {
          name,
          path: fullPath,
          has_session: hasSession,
          created_at: fs.statSync(fullPath).birthtime.toISOString()
        };
      });
    
    res.json({ profiles });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/chrome/launch-login
 * Mở Chrome có giao diện để user đăng nhập tay
 * Body: { profile: "default", url: "https://accounts.google.com" }
 */
router.post('/launch-login', (req, res) => {
  const { profile = 'default', url = 'https://accounts.google.com' } = req.body;

  console.log(`[Chrome Manager] Launching login browser for profile: ${profile}`);

  const pythonProcess = spawn(pythonExe, [
    chromeManagerScript, 'login',
    '--profile', profile,
    '--url', url
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true  // Cho phép Chrome chạy độc lập
  });

  let firstOutput = '';

  pythonProcess.stdout.on('data', (data) => {
    const text = data.toString();
    firstOutput += text;
    console.log(`[Chrome Manager] ${text.trim()}`);
  });

  pythonProcess.stderr.on('data', (data) => {
    console.error(`[Chrome Manager Error] ${data.toString().trim()}`);
  });

  // Trả response ngay khi Chrome đã mở (không chờ user đóng)
  setTimeout(() => {
    pythonProcess.unref(); // Cho phép Node.js thoát mà Chrome vẫn chạy
    res.json({
      status: 'launched',
      message: `Chrome đã mở với profile "${profile}". Hãy đăng nhập rồi đóng Chrome.`,
      profile
    });
  }, 2000);
});

/**
 * POST /api/chrome/create-profile
 * Tạo profile mới
 * Body: { name: "my-google-account" }
 */
router.post('/create-profile', (req, res) => {
  const { name } = req.body;
  
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: 'Tên profile chỉ được chứa chữ, số, dấu gạch ngang' });
  }

  const profilePath = path.join(profilesDir, name);
  
  if (fs.existsSync(profilePath)) {
    return res.status(409).json({ error: 'Profile đã tồn tại' });
  }

  fs.mkdirSync(profilePath, { recursive: true });
  res.json({
    status: 'created',
    name,
    path: profilePath
  });
});

/**
 * DELETE /api/chrome/profiles/:name
 * Xóa profile
 */
router.delete('/profiles/:name', (req, res) => {
  const { name } = req.params;
  const profilePath = path.join(profilesDir, name);

  if (!fs.existsSync(profilePath)) {
    return res.status(404).json({ error: 'Profile không tồn tại' });
  }

  try {
    fs.rmSync(profilePath, { recursive: true, force: true });
    res.json({ status: 'deleted', name });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
