import { Router, type Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { config } from '../config/env';

const router = Router();

const generatedDir = path.join(process.cwd(), 'generated');
const jobsDir = path.join(process.cwd(), 'tmp', 'jobs');
const workerLogsDir = path.join(generatedDir, '_logs');
const flowWorkerScript = path.join(process.cwd(), 'python_workers', 'browser_automation.py');
const videoWorkerScript = path.join(process.cwd(), 'python_workers', 'video_editor.py');

type WorkerType = 'image' | 'video' | 'scene';

interface PythonCandidate {
  command: string;
  argsPrefix: string[];
}

interface FlowJobPayload {
  type: WorkerType;
  prompt?: string;
  image_prompt?: string;
  video_prompt?: string;
  profile: string;
  flow_url: string;
  headless: boolean;
  output_dir: string;
  public_base_url: string;
  file_prefix?: string;
  scene_index?: number;
  reference_images?: string[];
  source_image_url?: string;
  project_url?: string;
  create_project?: boolean;
  run_id?: string;
  options?: Record<string, unknown>;
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface WorkerEvent {
  type: string;
  data: Record<string, unknown>;
}

type WorkerEventHandler = (event: WorkerEvent) => void;

const workerEventPrefix = 'FLOW_EVENT ';

function ensureRuntimeDirs() {
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(workerLogsDir, { recursive: true });
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

function safeRunId(value: string) {
  return sanitizeFilePart(value || crypto.randomUUID()).slice(0, 120);
}

function logPathForRunId(runId: string) {
  return path.join(workerLogsDir, `${safeRunId(runId)}.log`);
}

function appendWorkerLog(runId: string, message: string) {
  ensureRuntimeDirs();
  const line = `[${new Date().toISOString()}] ${message.replace(/\r?\n/g, '\n')}\n`;
  fs.appendFileSync(logPathForRunId(runId), line, 'utf8');
}

function writeSse(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function startSse(res: Response) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

function parseWorkerEvent(line: string): WorkerEvent | null {
  if (!line.startsWith(workerEventPrefix)) return null;

  try {
    const payload = JSON.parse(line.slice(workerEventPrefix.length));
    const type = typeof payload.event === 'string' ? payload.event : 'message';
    const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
    return { type, data };
  } catch {
    return {
      type: 'log',
      data: { message: `invalid worker event: ${line}` },
    };
  }
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

function runProcess(
  command: string,
  args: string[],
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      onOutput?.('stdout', text);
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      onOutput?.('stderr', text);
    });

    child.on('error', (error) => {
      onOutput?.('stderr', error.message);
      reject(error);
    });
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

async function runFlowWorker(payload: FlowJobPayload, onEvent?: WorkerEventHandler) {
  ensureRuntimeDirs();
  const jobId = safeRunId(payload.run_id || crypto.randomUUID());
  const jobPath = path.join(jobsDir, `${jobId}.json`);
  fs.writeFileSync(jobPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(logPathForRunId(jobId), '', 'utf8');
  appendWorkerLog(jobId, `job started: type=${payload.type}, scene=${payload.scene_index || 1}`);
  onEvent?.({
    type: 'log',
    data: { runId: jobId, message: `job started: type=${payload.type}, scene=${payload.scene_index || 1}` },
  });

  let lastError = '';

  for (const candidate of getPythonCandidates()) {
    const args = [...candidate.argsPrefix, flowWorkerScript, '--job', jobPath];
    console.log(`[Flow Worker] ${candidate.command} ${args.join(' ')}`);
    appendWorkerLog(jobId, `spawn: ${candidate.command} ${args.join(' ')}`);
    onEvent?.({
      type: 'log',
      data: { runId: jobId, message: `spawn: ${candidate.command} ${args.join(' ')}` },
    });

    const lineBuffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
    const handleWorkerLine = (stream: 'stdout' | 'stderr', line: string) => {
      const workerEvent = parseWorkerEvent(line);
      if (workerEvent) {
        appendWorkerLog(jobId, `event: ${workerEvent.type} ${JSON.stringify(workerEvent.data)}`);
        onEvent?.(workerEvent);
        return;
      }

      const label = stream === 'stderr' ? 'worker' : 'result';
      if (line.startsWith('[BOT]') || line.startsWith('Progress:')) {
        console.log(line);
      } else {
        // Keep debug logs out of the main console output to keep it clean, but save to file
      }
      appendWorkerLog(jobId, `${label}: ${line}`);
      onEvent?.({
        type: 'log',
        data: { runId: jobId, stream, message: `${label}: ${line}` },
      });
    };

    const handleWorkerChunk = (stream: 'stdout' | 'stderr', text: string) => {
      lineBuffers[stream] += text;
      const lines = lineBuffers[stream].split(/\r?\n/);
      lineBuffers[stream] = lines.pop() || '';
      for (const line of lines.filter(Boolean)) {
        handleWorkerLine(stream, line);
      }
    };

    const flushWorkerLines = () => {
      (['stdout', 'stderr'] as const).forEach((stream) => {
        const line = lineBuffers[stream].trim();
        if (line) handleWorkerLine(stream, line);
        lineBuffers[stream] = '';
      });
    };

    try {
      const result = await runProcess(candidate.command, args, handleWorkerChunk);
      flushWorkerLines();
      const parsed = result.stdout.trim() ? parseWorkerJson(result.stdout) : null;
      if (result.code !== 0) {
        lastError = parsed?.message || result.stderr || result.stdout || `Python exited with code ${result.code}`;
        console.error(`[Flow Worker] failed with ${candidate.command}: ${lastError}`);
        appendWorkerLog(jobId, `failed: ${lastError}`);
        onEvent?.({
          type: 'log',
          data: { runId: jobId, message: `failed: ${lastError}` },
        });
        continue;
      }

      if (!parsed) {
        throw new Error('Python worker produced no JSON output');
      }
      if (parsed.status === 'error') {
        throw new Error(parsed.message || 'Flow worker returned error');
      }
      appendWorkerLog(jobId, 'job completed successfully');
      onEvent?.({
        type: 'log',
        data: { runId: jobId, message: 'job completed successfully' },
      });
      return parsed;
    } catch (error: any) {
      flushWorkerLines();
      lastError = error?.message || String(error);
      console.error(`[Flow Worker] failed with ${candidate.command}: ${lastError}`);
      appendWorkerLog(jobId, `error: ${lastError}`);
      onEvent?.({
        type: 'log',
        data: { runId: jobId, message: `error: ${lastError}` },
      });
    }
  }

  appendWorkerLog(jobId, `job failed: ${lastError}`);
  onEvent?.({
    type: 'log',
    data: { runId: jobId, message: `job failed: ${lastError}` },
  });
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

router.get('/logs/:runId', (req, res) => {
  try {
    const runId = safeRunId(req.params.runId);
    const filePath = logPathForRunId(runId);
    const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    res.json({ runId, text });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/flow-image', async (req, res) => {
  const {
    prompt,
    profile = 'default',
    referenceImages = [],
    options = {},
    filePrefix = 'film',
    sceneIndex = 1,
    projectUrl = '',
    createProject = false,
    runId = '',
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
      project_url: typeof projectUrl === 'string' ? projectUrl : '',
      create_project: Boolean(createProject),
      run_id: typeof runId === 'string' ? runId : '',
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
    projectUrl = '',
    runId = '',
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
      project_url: typeof projectUrl === 'string' ? projectUrl : '',
      run_id: typeof runId === 'string' ? runId : '',
      options,
    });

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/flow-scene/stream', async (req, res) => {
  const {
    imagePrompt,
    videoPrompt,
    profile = 'default',
    referenceImages = [],
    options = {},
    filePrefix = 'film',
    sceneIndex = 1,
    projectUrl = '',
    createProject = false,
    runId = '',
  } = req.body;

  if (!imagePrompt || typeof imagePrompt !== 'string') {
    return res.status(400).json({ error: 'imagePrompt is required' });
  }

  if (!videoPrompt || typeof videoPrompt !== 'string') {
    return res.status(400).json({ error: 'videoPrompt is required' });
  }

  startSse(res);
  let clientClosed = false;
  res.on('close', () => {
    clientClosed = true;
  });

  const send = (event: string, data: unknown) => {
    if (!clientClosed && !res.writableEnded) {
      writeSse(res, event, data);
    }
  };

  try {
    const result = await runFlowWorker({
      type: 'scene',
      image_prompt: imagePrompt,
      video_prompt: videoPrompt,
      profile,
      flow_url: config.googleFlowUrl,
      headless: config.playwrightHeadless,
      output_dir: generatedDir,
      public_base_url: `${config.publicApiUrl.replace(/\/$/, '')}/generated`,
      file_prefix: sanitizeFilePart(filePrefix),
      scene_index: Number(sceneIndex) || 1,
      reference_images: Array.isArray(referenceImages) ? referenceImages : [],
      project_url: typeof projectUrl === 'string' ? projectUrl : '',
      create_project: Boolean(createProject),
      run_id: typeof runId === 'string' ? runId : '',
      options,
    }, (event) => send(event.type, event.data));

    send('done', result);
  } catch (error: any) {
    send('error', { error: error.message || String(error) });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

router.post('/flow-scene', async (req, res) => {
  const {
    imagePrompt,
    videoPrompt,
    profile = 'default',
    referenceImages = [],
    options = {},
    filePrefix = 'film',
    sceneIndex = 1,
    projectUrl = '',
    createProject = false,
    runId = '',
  } = req.body;

  if (!imagePrompt || typeof imagePrompt !== 'string') {
    return res.status(400).json({ error: 'imagePrompt is required' });
  }

  if (!videoPrompt || typeof videoPrompt !== 'string') {
    return res.status(400).json({ error: 'videoPrompt is required' });
  }

  try {
    const result = await runFlowWorker({
      type: 'scene',
      image_prompt: imagePrompt,
      video_prompt: videoPrompt,
      profile,
      flow_url: config.googleFlowUrl,
      headless: config.playwrightHeadless,
      output_dir: generatedDir,
      public_base_url: `${config.publicApiUrl.replace(/\/$/, '')}/generated`,
      file_prefix: sanitizeFilePart(filePrefix),
      scene_index: Number(sceneIndex) || 1,
      reference_images: Array.isArray(referenceImages) ? referenceImages : [],
      project_url: typeof projectUrl === 'string' ? projectUrl : '',
      create_project: Boolean(createProject),
      run_id: typeof runId === 'string' ? runId : '',
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
    bgmUrl,
    autoSubtitles,
    filePrefix = 'film',
    videoTitle = '',
  } = req.body;

  if (!Array.isArray(videoUrls) || videoUrls.length === 0) {
    return res.status(400).json({ error: 'videoUrls must be a non-empty array' });
  }

  try {
    ensureRuntimeDirs();
    const inputPaths = videoUrls.map((url) => resolveGeneratedUrlToPath(String(url)));
    
    let resolvedBgmPath = '';
    if (bgmUrl && typeof bgmUrl === 'string') {
      if (bgmUrl.startsWith('http')) {
        resolvedBgmPath = bgmUrl;
      } else {
        try {
          resolvedBgmPath = resolveGeneratedUrlToPath(bgmUrl);
        } catch {
          // If it's not a generated asset, just pass it (e.g. an absolute path)
          resolvedBgmPath = bgmUrl;
        }
      }
    }

    const outputPath = path.join(generatedDir, `${sanitizeFilePart(filePrefix)}_final_${Date.now()}.mp4`);
    
    const jobId = safeRunId(crypto.randomUUID());
    const jobPath = path.join(jobsDir, `video-job-${jobId}.json`);
    const jobPayload = {
      videoUrls: inputPaths,
      bgmUrl: resolvedBgmPath,
      auto_subtitles: Boolean(autoSubtitles),
      output_path: outputPath,
      videoTitle: String(videoTitle)
    };
    fs.writeFileSync(jobPath, JSON.stringify(jobPayload, null, 2), 'utf8');

    let parsed = null;
    let lastError = '';
    
    for (const candidate of getPythonCandidates()) {
      const args = [...candidate.argsPrefix, videoWorkerScript, '--job', jobPath];
      console.log(`[Video Editor] ${candidate.command} ${args.join(' ')}`);
      try {
        const result = await runProcess(candidate.command, args);
        if (result.code !== 0) {
           lastError = result.stderr || result.stdout;
           continue;
        }
        parsed = parseWorkerJson(result.stdout);
        if (parsed.status === 'error') {
           lastError = parsed.message;
           continue;
        }
        break; // Success
      } catch (err: any) {
        lastError = err.message;
      }
    }

    if (!parsed || parsed.status === 'error') {
       throw new Error(`Video editor failed: ${lastError}`);
    }

    res.json({
      status: 'success',
      type: 'concat',
      result_url: publicUrlForFile(parsed.local_path),
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
