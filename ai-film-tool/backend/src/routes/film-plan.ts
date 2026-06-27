import { Router, type Request, type Response } from 'express';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

const router = Router();
const jobsDir = path.join(process.cwd(), 'tmp', 'jobs');

// Ensure jobs dir exists
if (!fs.existsSync(jobsDir)) {
  fs.mkdirSync(jobsDir, { recursive: true });
}

// System prompts and orchestration are now handled entirely in Python (chatgpt_planner.py)
// to support multi-step generation and avoid JSON truncation.

router.post('/', (req: Request, res: Response): void => {
  const { idea, duration, aspectRatio, language, style, audience } = req.body;

  if (!idea) {
    res.status(400).json({ error: 'idea is required' });
    return;
  }

  const jobId = crypto.randomUUID();
  const jobFile = path.join(jobsDir, `chatgpt_${jobId}.json`);
  
  const jobPayload = {
    idea: idea,
    settings: {
      duration: duration || '60',
      aspectRatio: aspectRatio || '16:9',
      language: language || 'Vietnamese',
      style: style || 'cinematic',
      audience: audience || 'general'
    },
    profile: 'chatgpt',
    headless: false // Mở trình duyệt để người dùng xem/debug, giống flow
  };

  fs.writeFileSync(jobFile, JSON.stringify(jobPayload, null, 2));

  const workerScript = path.join(process.cwd(), 'python_workers', 'chatgpt_planner.py');

  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const child = spawn(pythonCmd, [workerScript, '--job', jobFile]);

  let stdoutData = '';
  let stderrData = '';

  child.stdout.on('data', (data) => {
    stdoutData += data.toString();
  });

  child.stderr.on('data', (data) => {
    stderrData += data.toString();
    console.error(`[ChatGPT Worker] ${data.toString().trim()}`);
  });

  child.on('close', (code) => {
    // try to clean up job file
    try { if (fs.existsSync(jobFile)) fs.unlinkSync(jobFile); } catch (e) {}

    if (code !== 0) {
      console.error(`[ChatGPT Worker] exited with code ${code}`);
      console.error(`[ChatGPT Worker STDOUT]:\n${stdoutData}`);
      if (stderrData) console.error(`[ChatGPT Worker STDERR]:\n${stderrData}`);
      let errMsg = stderrData || stdoutData || 'Unknown error occurred in ChatGPT worker';
      try {
        const parsed = JSON.parse(stdoutData);
        if (parsed.error) errMsg = parsed.error;
      } catch (e) {}
      res.status(500).json({ error: errMsg });
      return;
    }

    try {
      const parsed = JSON.parse(stdoutData);
      if (parsed.error) {
        return res.status(500).json({ error: parsed.error });
      }
      res.json(parsed);
    } catch (e: any) {
      console.error('[ChatGPT Worker] Failed to parse output as JSON:', stdoutData);
      res.status(500).json({ error: 'Invalid JSON from ChatGPT worker', raw: stdoutData });
    }
  });
});

export default router;
