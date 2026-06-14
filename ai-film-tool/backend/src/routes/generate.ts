import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { config } from '../config/env';

const router = Router();

const generatedDir = path.join(process.cwd(), 'generated');
const jobsDir = path.join(process.cwd(), 'tmp', 'jobs');
const flowWorkerScript = path.join(process.cwd(), 'python_workers', 'browser_automation.py');

type WorkerType = 'image' | 'video';

interface PythonCandidate {
  command: string;
  argsPrefix: string[];
}

interface FlowJobPayload {
  type: WorkerType;
  prompt: string;
  profile: string;
  flow_url: string;
  headless: boolean;
  output_dir: string;
  public_base_url: string;
  file_prefix?: string;
  scene_index?: number;
  reference_images?: string[];
  source_image_url?: string;
  options?: Record<string, unknown>;
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function ensureRuntimeDirs() {
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
}

function publicUrlForFile(filePath: string) {
  return `${config.publicApiUrl.replace(/\/$/, '')}/generated/${encodeURIComponent(path.basename(filePath))}`;
}

function sanitizeFilePart(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'film';
}

function getPythonCandidates(): PythonCandidate[] {
  const candidates: PythonCandidate[] = [];

  if (config.pythonExecutable) {
    candidates.push({ command: config.pythonExecutable, argsPrefix: [] });
  }

  const venvPython = process.platform === 'win32'
    ? path.join(process.cwd(), 'venv', 'Scripts', 'python.exe')
    : path.join(process.cwd(), 'venv', 'bin', 'python');

  if (fs.existsSync(venvPython)) {
    candidates.push({ command: venvPython, argsPrefix: [] });
  }

  candidates.push({ command: 'python', argsPrefix: [] });
  candidates.push({ command: 'py', argsPrefix: ['-3'] });

  return candidates;
}

function runProcess(command: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function parseWorkerJson(stdout: string) {
  const trimmed = stdout.trim();
  const jsonStart = trimmed.indexOf('{');
  const jsonEnd = trimmed.lastIndexOf('}');

  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new Error('No JSON found in Python worker output');
  }

  return JSON.parse(trimmed.substring(jsonStart, jsonEnd + 1));
}

async function runFlowWorker(payload: FlowJobPayload) {
  ensureRuntimeDirs();
  const jobId = crypto.randomUUID();
  const jobPath = path.join(jobsDir, `${jobId}.json`);
  fs.writeFileSync(jobPath, JSON.stringify(payload, null, 2), 'utf8');

  let lastError = '';

  for (const candidate of getPythonCandidates()) {
    const args = [...candidate.argsPrefix, flowWorkerScript, '--job', jobPath];
    console.log(`[Flow Worker] ${candidate.command} ${args.join(' ')}`);

    try {
      const result = await runProcess(candidate.command, args);
      if (result.code !== 0) {
        lastError = result.stderr || result.stdout || `Python exited with code ${result.code}`;
        console.error(`[Flow Worker] failed with ${candidate.command}: ${lastError}`);
        continue;
      }

      const parsed = parseWorkerJson(result.stdout);
      if (parsed.status === 'error') {
        throw new Error(parsed.message || 'Flow worker returned error');
      }
      return parsed;
    } catch (error: any) {
      lastError = error?.message || String(error);
      console.error(`[Flow Worker] failed with ${candidate.command}: ${lastError}`);
    }
  }

  throw new Error(`Could not run Python Flow worker. ${lastError}`);
}

function resolveGeneratedUrlToPath(url: string) {
  const marker = '/generated/';
  const markerIndex = url.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Video URL is not a generated local asset: ${url}`);
  }

  const rawName = url.slice(markerIndex + marker.length).split(/[?#]/)[0] || '';
  const filename = decodeURIComponent(rawName);

  if (!filename || filename.includes('/') || filename.includes('\\')) {
    throw new Error(`Invalid generated asset name: ${filename}`);
  }

  const filePath = path.join(generatedDir, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Generated file does not exist: ${filename}`);
  }

  return filePath;
}

async function runFfmpegConcat(inputPaths: string[], outputPath: string, transcode: boolean) {
  ensureRuntimeDirs();
  const listPath = path.join(jobsDir, `concat-${crypto.randomUUID()}.txt`);
  const listContent = inputPaths
    .map((filePath) => `file '${filePath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(listPath, listContent, 'utf8');

  const args = [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
  ];

  if (transcode) {
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart');
  } else {
    args.push('-c', 'copy');
  }

  args.push(outputPath);
  const result = await runProcess('ffmpeg', args);

  if (result.code !== 0) {
    throw new Error(result.stderr || `ffmpeg exited with code ${result.code}`);
  }
}

router.get('/mock-image', (req, res) => {
  const seed = (req.query.seed as string) || crypto.randomUUID();
  const hash = crypto.createHash('md5').update(seed).digest('hex');
  const width = parseInt(req.query.w as string) || 800;
  const height = parseInt(req.query.h as string) || 600;

  res.json({
    status: 'success',
    result_url: `https://picsum.photos/seed/${hash}/${width}/${height}`,
    seed_used: seed,
    type: 'image',
  });
});

router.get('/mock-video', (req, res) => {
  res.json({
    status: 'success',
    result_url: 'https://www.w3schools.com/html/mov_bbb.mp4',
    seed_used: (req.query.seed as string) || crypto.randomUUID(),
    type: 'video',
  });
});

router.post('/flow-image', async (req, res) => {
  const {
    prompt,
    profile = 'default',
    referenceImages = [],
    options = {},
    filePrefix = 'film',
    sceneIndex = 1,
  } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt is required' });
  }

  try {
    const result = await runFlowWorker({
      type: 'image',
      prompt,
      profile,
      flow_url: config.googleFlowUrl,
      headless: config.playwrightHeadless,
      output_dir: generatedDir,
      public_base_url: `${config.publicApiUrl.replace(/\/$/, '')}/generated`,
      file_prefix: sanitizeFilePart(filePrefix),
      scene_index: Number(sceneIndex) || 1,
      reference_images: Array.isArray(referenceImages) ? referenceImages : [],
      options,
    });

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/flow-video', async (req, res) => {
  const {
    prompt,
    sourceImageUrl,
    profile = 'default',
    options = {},
    filePrefix = 'film',
    sceneIndex = 1,
  } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt is required' });
  }

  if (!sourceImageUrl || typeof sourceImageUrl !== 'string') {
    return res.status(400).json({ error: 'sourceImageUrl is required' });
  }

  try {
    const result = await runFlowWorker({
      type: 'video',
      prompt,
      profile,
      flow_url: config.googleFlowUrl,
      headless: config.playwrightHeadless,
      output_dir: generatedDir,
      public_base_url: `${config.publicApiUrl.replace(/\/$/, '')}/generated`,
      file_prefix: sanitizeFilePart(filePrefix),
      scene_index: Number(sceneIndex) || 1,
      source_image_url: sourceImageUrl,
      options,
    });

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/concat-videos', async (req, res) => {
  const {
    videoUrls,
    filePrefix = 'film',
  } = req.body;

  if (!Array.isArray(videoUrls) || videoUrls.length === 0) {
    return res.status(400).json({ error: 'videoUrls must be a non-empty array' });
  }

  try {
    ensureRuntimeDirs();
    const inputPaths = videoUrls.map((url) => resolveGeneratedUrlToPath(String(url)));
    const outputPath = path.join(generatedDir, `${sanitizeFilePart(filePrefix)}_final_${Date.now()}.mp4`);

    try {
      await runFfmpegConcat(inputPaths, outputPath, false);
    } catch (copyError) {
      console.warn('[FFmpeg] stream copy concat failed, retrying with transcode');
      await runFfmpegConcat(inputPaths, outputPath, true);
    }

    res.json({
      status: 'success',
      type: 'concat',
      result_url: publicUrlForFile(outputPath),
      input_count: inputPaths.length,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/python-gen', async (req, res) => {
  const { type, prompt, profile = 'default' } = req.body;

  if ((type !== 'image' && type !== 'video') || !prompt) {
    return res.status(400).json({ error: 'type must be image/video and prompt is required' });
  }

  try {
    const result = await runFlowWorker({
      type,
      prompt,
      profile,
      flow_url: config.googleFlowUrl,
      headless: config.playwrightHeadless,
      output_dir: generatedDir,
      public_base_url: `${config.publicApiUrl.replace(/\/$/, '')}/generated`,
      file_prefix: 'manual',
      scene_index: 1,
      reference_images: [],
    });

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
