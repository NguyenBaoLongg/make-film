import { create } from 'zustand';
import {
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react';
import type {
  Connection,
  Edge,
  EdgeChange,
  Node,
  NodeChange,
  OnNodesChange,
  OnEdgesChange,
  OnConnect,
} from '@xyflow/react';

import { supabase } from '../lib/supabase';
import { parseFilmPlanToNodes } from '../utils/filmPlanParser';

export type NodeStatus = 'waiting' | 'processing' | 'completed' | 'error';

export interface BaseNodeData {
  status?: NodeStatus;
  resultUrl?: string;
  localPath?: string;
  errorMessage?: string;
  [key: string]: unknown;
}

export interface AppState {
  nodes: Node[];
  edges: Edge[];
  concurrency: number;
  filePrefix: string;
  isRunning: boolean;
  pipelineProgress: { completed: number; total: number };
  pipelineLogs: string[];
  savedProjects: Array<{ id: string; title: string; created_at: string }>;
  currentProjectId: string | null;
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  setConcurrency: (val: number) => void;
  setFilePrefix: (val: string) => void;
  setIsRunning: (val: boolean) => void;
  clearPipelineLogs: () => void;
  addPipelineLog: (message: string) => void;
  updateNodeData: (nodeId: string, data: Partial<BaseNodeData>) => void;
  updateNodeStatus: (nodeId: string, status: NodeStatus, errorMessage?: string) => void;
  runPipeline: () => Promise<void>;
  loadFlowFromSupabase: (projectId: string) => Promise<void>;
  fetchSavedProjects: () => Promise<void>;
  applyFilmPlan: (plan: any) => void;
  generateFilmPlan: (idea: string, settings: any) => Promise<any>;
}

interface GenerateResponse {
  status: string;
  result_url: string;
  local_path?: string;
  project_url?: string;
  image_result_url?: string;
  image_local_path?: string;
  video_result_url?: string;
  video_local_path?: string;
  error?: string;
}

interface FlowSceneStreamCallbacks {
  image_done?: (result: GenerateResponse) => void;
  video_done?: (result: GenerateResponse) => void;
  scene_done?: (result: GenerateResponse) => void;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

type LogFn = (message: string) => void;

function nodeData(node: Node | undefined): BaseNodeData {
  return ((node?.data || {}) as BaseNodeData);
}

function dataString(node: Node, key: string, fallback = '') {
  const value = nodeData(node)[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function dataNumber(node: Node, key: string, fallback: number) {
  const value = nodeData(node)[key];
  return typeof value === 'number' ? value : fallback;
}

function sortedByScene(nodes: Node[]) {
  return [...nodes].sort((a, b) => {
    const aScene = dataNumber(a, 'sceneIndex', Number.MAX_SAFE_INTEGER);
    const bScene = dataNumber(b, 'sceneIndex', Number.MAX_SAFE_INTEGER);
    if (aScene !== bScene) return aScene - bScene;
    if (a.position.y !== b.position.y) return a.position.y - b.position.y;
    return a.position.x - b.position.x;
  });
}

function collectConnectedImageInputs(nodeId: string, nodes: Node[], edges: Edge[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const inputs: string[] = [];

  for (const edge of edges.filter((item) => item.target === nodeId)) {
    const sourceNode = byId.get(edge.source);
    if (!sourceNode) continue;

    const data = nodeData(sourceNode);
    const image = sourceNode.type === 'mediaSource'
      ? data.image
      : sourceNode.type === 'imageGen'
        ? data.resultUrl
        : undefined;

    if (typeof image === 'string' && image.length > 0) {
      inputs.push(image);
    }
  }

  return inputs;
}

function findConnectedVideos(imageId: string, nodes: Node[], edges: Edge[]) {
  const videoIds = new Set(
    edges
      .filter((edge) => edge.source === imageId)
      .map((edge) => edge.target),
  );

  return sortedByScene(nodes.filter((node) => node.type === 'videoGen' && videoIds.has(node.id)));
}

function findConcatInputs(concatId: string, nodes: Node[], edges: Edge[]) {
  const inputIds = new Set(
    edges
      .filter((edge) => edge.target === concatId)
      .map((edge) => edge.source),
  );

  const connectedVideos = nodes.filter((node) => node.type === 'videoGen' && inputIds.has(node.id));
  return sortedByScene(connectedVideos.length > 0
    ? connectedVideos
    : nodes.filter((node) => node.type === 'videoGen'));
}

async function apiPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const session = await supabase.auth.getSession();
  const token = session.data.session?.access_token;
  if (!token) throw new Error('No auth token. Please login again.');

  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(payload.error || payload.message || response.statusText);
  }

  return payload as T;
}

async function extractLastFrame(videoUrl: string, onLog: LogFn): Promise<string | null> {
  try {
    onLog(`Calling extract-frame API for ${videoUrl}...`);
    const res = await apiPost<{ status: string, result_url: string }>('/api/generate/extract-frame', { videoUrl });
    if (res.status === 'success') {
      return res.result_url;
    }
    throw new Error('API returned unsuccessful status for extract-frame.');
  } catch (e) {
    onLog(`Extract frame error: ${String(e)}`);
    throw e;
  }
}

function makeRunId(path: string, sceneIndex?: number) {
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${path.replace(/[^a-z0-9]+/gi, '-')}-${sceneIndex || 0}-${suffix}`;
}

function normalizeGenerateResponse(data: Record<string, unknown>): GenerateResponse {
  return {
    status: typeof data.status === 'string' ? data.status : 'success',
    result_url: typeof data.result_url === 'string' ? data.result_url : '',
    local_path: typeof data.local_path === 'string' ? data.local_path : undefined,
    project_url: typeof data.project_url === 'string' ? data.project_url : undefined,
    image_result_url: typeof data.image_result_url === 'string' ? data.image_result_url : undefined,
    image_local_path: typeof data.image_local_path === 'string' ? data.image_local_path : undefined,
    video_result_url: typeof data.video_result_url === 'string' ? data.video_result_url : undefined,
    video_local_path: typeof data.video_local_path === 'string' ? data.video_local_path : undefined,
    error: typeof data.error === 'string' ? data.error : undefined,
  };
}

async function apiPostWithLog<T>(
  path: string,
  body: Record<string, unknown>,
  onLog: LogFn,
  sceneIndex?: number,
): Promise<T> {
  const session = await supabase.auth.getSession();
  const token = session.data.session?.access_token;
  if (!token) throw new Error('No auth token. Please login again.');

  const runId = makeRunId(path, sceneIndex);
  let seenLength = 0;
  let stopped = false;

  const pollLogs = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/generate/logs/${encodeURIComponent(runId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return;

      const payload = await response.json() as { text?: string };
      const text = payload.text || '';
      if (text.length <= seenLength) return;

      const next = text.slice(seenLength);
      seenLength = text.length;
      next.split(/\r?\n/).filter(Boolean).forEach((line) => onLog(line));
    } catch {
      // Log polling is best-effort; generation errors still come from the main request.
    }
  };

  onLog(`[frontend] start ${path} runId=${runId}`);
  const interval = window.setInterval(() => {
    if (!stopped) void pollLogs();
  }, 1500);

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...body, runId }),
    });

    await pollLogs();
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};

    if (!response.ok) {
      throw new Error(payload.error || payload.message || response.statusText);
    }

    onLog(`[frontend] done ${path}`);
    return payload as T;
  } finally {
    stopped = true;
    window.clearInterval(interval);
    await pollLogs();
  }
}

async function apiPostStream<T>(
  path: string,
  body: Record<string, unknown>,
  onLog: LogFn,
  callbacks: FlowSceneStreamCallbacks,
  sceneIndex?: number,
): Promise<T> {
  const session = await supabase.auth.getSession();
  const token = session.data.session?.access_token;
  if (!token) throw new Error('No auth token. Please login again.');

  const runId = makeRunId(path, sceneIndex);
  onLog(`[frontend] stream start ${path} runId=${runId}`);

  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ ...body, runId }),
  });

  if (!response.ok) {
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    throw new Error(payload.error || payload.message || response.statusText);
  }

  if (!response.body) {
    throw new Error('Streaming response is not available in this browser.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalPayload: T | undefined;
  let streamError: Error | undefined;

  const dispatchEvent = (raw: string) => {
    if (!raw.trim()) return;

    let event = 'message';
    const dataLines: string[] = [];

    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    const dataText = dataLines.join('\n');
    const rawPayload = dataText ? JSON.parse(dataText) as Record<string, unknown> : {};
    const payload = normalizeGenerateResponse(rawPayload);

    if (event === 'log') {
      const message = typeof rawPayload.message === 'string'
        ? rawPayload.message
        : JSON.stringify(rawPayload);
      onLog(message);
      return;
    }

    if (event === 'error') {
      streamError = new Error(payload.error || 'Stream generation failed.');
      return;
    }

    if (event === 'image_done') callbacks.image_done?.(payload);
    if (event === 'video_done') callbacks.video_done?.(payload);
    if (event === 'scene_done') callbacks.scene_done?.(payload);
    if (event === 'done') finalPayload = payload as T;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex !== -1) {
      const raw = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      dispatchEvent(raw);
      separatorIndex = buffer.indexOf('\n\n');
    }
  }

  buffer += decoder.decode().replace(/\r\n/g, '\n');
  if (buffer.trim()) dispatchEvent(buffer);

  if (streamError) throw streamError;
  if (!finalPayload) throw new Error('Stream finished without a final result.');

  onLog(`[frontend] stream done ${path}`);
  return finalPayload;
}

async function createFlowImage(params: {
  prompt: string;
  referenceImages: string[];
  node: Node;
  filePrefix: string;
  sceneIndex: number;
  projectUrl?: string;
  createProject?: boolean;
  onLog: LogFn;
}) {
  return apiPostWithLog<GenerateResponse>('/api/generate/flow-image', {
    prompt: params.prompt,
    referenceImages: params.referenceImages,
    filePrefix: params.filePrefix,
    sceneIndex: params.sceneIndex,
    projectUrl: params.projectUrl || '',
    createProject: Boolean(params.createProject),
    profile: 'default',
    options: {
      imageModel: dataString(params.node, 'model'),
      imageResolution: dataString(params.node, 'resolution'),
      imageRatio: dataString(params.node, 'ratio'),
    },
  }, params.onLog, params.sceneIndex);
}

async function createFlowVideo(params: {
  prompt: string;
  sourceImageUrl: string;
  node: Node;
  filePrefix: string;
  sceneIndex: number;
  projectUrl?: string;
  onLog: LogFn;
}) {
  return apiPostWithLog<GenerateResponse>('/api/generate/flow-video', {
    prompt: params.prompt,
    sourceImageUrl: params.sourceImageUrl,
    filePrefix: params.filePrefix,
    sceneIndex: params.sceneIndex,
    projectUrl: params.projectUrl || '',
    profile: 'default',
    options: {
      videoModel: dataString(params.node, 'model'),
      videoResolution: dataString(params.node, 'resolution'),
      videoRatio: dataString(params.node, 'ratio'),
      videoMode: dataString(params.node, 'mode'),
      duration: nodeData(params.node).duration,
      voiceover: nodeData(params.node).voiceover,
    },
  }, params.onLog, params.sceneIndex);
}

async function createFlowScene(params: {
  imagePrompt: string;
  videoPrompt: string;
  referenceImages: string[];
  imageNode: Node;
  videoNode: Node;
  filePrefix: string;
  sceneIndex: number;
  projectUrl?: string;
  createProject?: boolean;
  onLog: LogFn;
  onImageDone?: (result: GenerateResponse) => void;
  onVideoDone?: (result: GenerateResponse) => void;
  onSceneDone?: (result: GenerateResponse) => void;
}) {
  return apiPostStream<GenerateResponse>('/api/generate/flow-scene/stream', {
    imagePrompt: params.imagePrompt,
    videoPrompt: params.videoPrompt,
    referenceImages: params.referenceImages,
    filePrefix: params.filePrefix,
    sceneIndex: params.sceneIndex,
    projectUrl: params.projectUrl || '',
    createProject: Boolean(params.createProject),
    profile: 'default',
    options: {
      imageModel: dataString(params.imageNode, 'model'),
      imageResolution: dataString(params.imageNode, 'resolution'),
      imageRatio: dataString(params.imageNode, 'ratio'),
      videoModel: dataString(params.videoNode, 'model'),
      videoResolution: dataString(params.videoNode, 'resolution'),
      videoRatio: dataString(params.videoNode, 'ratio'),
      videoMode: dataString(params.videoNode, 'mode'),
      duration: nodeData(params.videoNode).duration,
      voiceover: nodeData(params.videoNode).voiceover,
    },
  }, params.onLog, {
    image_done: params.onImageDone,
    video_done: params.onVideoDone,
    scene_done: params.onSceneDone,
  }, params.sceneIndex);
}

async function concatVideos(videoUrls: string[], filePrefix: string, bgmUrl?: string, autoSubtitles?: boolean, videoTitle?: string) {
  return apiPost<GenerateResponse>('/api/generate/concat-videos', {
    videoUrls,
    bgmUrl,
    autoSubtitles,
    filePrefix,
    videoTitle,
  });
}

export const useStore = create<AppState>((set, get) => ({
  nodes: [],
  edges: [],
  concurrency: 1,
  filePrefix: 'FILM_',
  isRunning: false,
  pipelineProgress: { completed: 0, total: 0 },
  pipelineLogs: [],
  savedProjects: [],
  currentProjectId: null,

  onNodesChange: (changes: NodeChange[]) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) });
  },

  onEdgesChange: (changes: EdgeChange[]) => {
    set({ edges: applyEdgeChanges(changes, get().edges) });
  },

  onConnect: (connection: Connection) => {
    set({
      edges: addEdge({
        ...connection,
        style: { stroke: '#10b981', strokeWidth: 2 },
        markerEnd: { type: 'arrowclosed' as any, color: '#10b981' },
      }, get().edges),
    });
  },

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  setConcurrency: (val) => set({ concurrency: val }),
  setFilePrefix: (val) => set({ filePrefix: val }),
  setIsRunning: (val) => set({ isRunning: val }),
  clearPipelineLogs: () => set({ pipelineLogs: [] }),
  addPipelineLog: (message) => {
    const timestamp = new Date().toLocaleTimeString();
    set({ pipelineLogs: [...get().pipelineLogs.slice(-300), `[${timestamp}] ${message}`] });
  },

  updateNodeData: (nodeId, data) => {
    set({
      nodes: get().nodes.map((node) => (
        node.id === nodeId
          ? { ...node, data: { ...node.data, ...data } }
          : node
      )),
    });
  },

  updateNodeStatus: (nodeId, status, errorMessage) => {
    set({
      nodes: get().nodes.map((node) => (
        node.id === nodeId
          ? { ...node, data: { ...node.data, status, errorMessage } }
          : node
      )),
    });
  },

  runPipeline: async () => {
    const initialNodes = get().nodes;
    const initialEdges = get().edges;
    if (initialNodes.length === 0) return;

    const resetNodes = initialNodes.map((node) => {
      // KHÔNG reset các node đã chạy xong thành công để hỗ trợ tính năng Resume (Chạy tiếp)
      if (node.data?.status === 'completed' && node.data?.resultUrl) {
        return node;
      }

      const shouldClearResult = node.type === 'imageGen' || node.type === 'videoGen' || node.type === 'concat';
      const nextData: BaseNodeData = {
        ...nodeData(node),
        status: 'waiting',
        errorMessage: undefined,
      };

      if (shouldClearResult) {
        nextData.resultUrl = undefined;
        nextData.localPath = undefined;
      }

      return { ...node, data: nextData };
    });

    const mediaNodes = sortedByScene(resetNodes.filter((node) => node.type === 'mediaSource'));
    const imageNodes = sortedByScene(resetNodes.filter((node) => node.type === 'imageGen'));
    const videoNodes = sortedByScene(resetNodes.filter((node) => node.type === 'videoGen'));
    const concatNodes = sortedByScene(resetNodes.filter((node) => node.type === 'concat'));
    const totalSteps = mediaNodes.length + imageNodes.length + videoNodes.length + concatNodes.length;

    set({
      nodes: resetNodes,
      isRunning: true,
      pipelineProgress: { completed: 0, total: totalSteps },
      pipelineLogs: [],
    });
    get().addPipelineLog(`Pipeline started: ${imageNodes.length} image node(s), ${videoNodes.length} video node(s).`);

    let completed = 0;
    const markStepDone = () => {
      completed += 1;
      set({ pipelineProgress: { completed, total: totalSteps } });
    };

    try {
      const pairedVideoIds = new Set<string>();
      let flowProjectUrl = '';
      let shouldCreateProject = true;

      for (const mediaNode of mediaNodes) {
        get().updateNodeStatus(mediaNode.id, 'completed');
        get().addPipelineLog(`Media ready: ${mediaNode.id}`);
        markStepDone();
      }

      if (imageNodes.length === 0 && videoNodes.length > 0) {
        throw new Error('Pipeline requires each video node to be connected after an image node.');
      }

      let previousLastFrameUrl: string | null = null;

      for (let index = 0; index < imageNodes.length; index += 1) {
        const imageNode = get().nodes.find((node) => node.id === imageNodes[index].id);
        if (!imageNode) continue;

        const sceneIndex = dataNumber(imageNode, 'sceneIndex', index + 1);
        let imagePrompt = dataString(imageNode, 'prompt', `Scene ${sceneIndex} image`);
        const referenceImages = collectConnectedImageInputs(imageNode.id, get().nodes, initialEdges);

        if (sceneIndex > 0 && previousLastFrameUrl) {
          referenceImages.push(previousLastFrameUrl);
          imagePrompt = `${imagePrompt}\n\n[CONTINUITY] Please use the attached last frame as the exact starting point and continue the action seamlessly. Do not change character appearance, clothing, or environment lighting.`;
          get().addPipelineLog(`Scene ${sceneIndex}: injected last frame from previous shot & continuity prompt.`);
        }
        const videosForImage = findConnectedVideos(imageNode.id, get().nodes, initialEdges);

        get().updateNodeStatus(imageNode.id, 'processing');
        get().addPipelineLog(`Scene ${sceneIndex}: start image node ${imageNode.id}, refs=${referenceImages.length}.`);

        if (videosForImage.length === 1) {
          const videoNodeBase = videosForImage[0];
          const videoNode = get().nodes.find((node) => node.id === videoNodeBase.id);
          if (!videoNode) continue;

          pairedVideoIds.add(videoNode.id);
          const videoPrompt = dataString(videoNode, 'motionPrompt', `Scene ${sceneIndex} motion`);
          get().addPipelineLog(`Scene ${sceneIndex}: image+video will run in one Chrome session.`);

          let imageMarkedDone = false;
          let videoMarkedDone = false;

          const applySceneImage = (result: GenerateResponse) => {
            if (imageMarkedDone) return;

            const imageUrl = result.image_result_url || result.result_url;
            if (!imageUrl) return;

            get().updateNodeData(imageNode.id, {
              resultUrl: imageUrl,
              localPath: result.image_local_path || result.local_path,
            });
            get().updateNodeStatus(imageNode.id, 'completed');
            get().addPipelineLog(`Scene ${sceneIndex}: image completed.`);
            markStepDone();
            imageMarkedDone = true;

            get().updateNodeStatus(videoNode.id, 'processing');
            get().addPipelineLog(`Scene ${sceneIndex}: start video node ${videoNode.id}.`);
          };

          const applySceneVideo = (result: GenerateResponse) => {
            if (videoMarkedDone) return;

            const videoUrl = result.video_result_url || result.result_url;
            if (!videoUrl) return;

            get().updateNodeData(videoNode.id, {
              resultUrl: videoUrl,
              localPath: result.video_local_path || result.local_path,
            });
            get().updateNodeStatus(videoNode.id, 'completed');
            get().addPipelineLog(`Scene ${sceneIndex}: video completed.`);
            markStepDone();
            videoMarkedDone = true;
          };

          if (imageNode.data?.status === 'completed' && imageNode.data?.resultUrl) {
            get().addPipelineLog(`Scene ${sceneIndex}: image already exists, skipping image generation.`);
            imageMarkedDone = true;
            markStepDone();

            if (videoNode.data?.status === 'completed' && videoNode.data?.resultUrl) {
              get().addPipelineLog(`Scene ${sceneIndex}: video already exists, skipping video generation.`);
              videoMarkedDone = true;
              markStepDone();
            } else {
              get().updateNodeStatus(videoNode.id, 'processing');
              get().addPipelineLog(`Scene ${sceneIndex}: start video node ${videoNode.id}.`);

              const videoResult = await createFlowVideo({
                prompt: videoPrompt,
                sourceImageUrl: (imageNode.data.localPath as string) || (imageNode.data.resultUrl as string),
                node: videoNode,
                filePrefix: get().filePrefix,
                sceneIndex,
                projectUrl: flowProjectUrl,
                onLog: get().addPipelineLog,
              });

              flowProjectUrl = videoResult.project_url || flowProjectUrl;
              applySceneVideo({
                ...videoResult,
                result_url: videoResult.video_result_url || videoResult.result_url,
                local_path: videoResult.video_local_path || videoResult.local_path,
              });
              if (!videoMarkedDone) {
                throw new Error(`Video scene ${sceneIndex} finished without a result URL`);
              }
            }
          } else {
            const sceneResult = await createFlowScene({
              imagePrompt,
              videoPrompt,
              referenceImages,
              imageNode,
              videoNode,
              filePrefix: get().filePrefix,
              sceneIndex,
              projectUrl: flowProjectUrl,
              createProject: shouldCreateProject,
              onLog: get().addPipelineLog,
              onImageDone: applySceneImage,
              onVideoDone: applySceneVideo,
              onSceneDone: () => get().addPipelineLog(`Scene ${sceneIndex}: scene completed.`),
            });

            flowProjectUrl = sceneResult.project_url || flowProjectUrl;
            shouldCreateProject = false;

            applySceneImage({
              ...sceneResult,
              result_url: sceneResult.image_result_url || sceneResult.result_url,
              local_path: sceneResult.image_local_path || sceneResult.local_path,
            });
            if (!imageMarkedDone) {
              throw new Error(`Image scene ${sceneIndex} finished without a result URL`);
            }

            applySceneVideo({
              ...sceneResult,
              result_url: sceneResult.video_result_url || sceneResult.result_url,
              local_path: sceneResult.video_local_path || sceneResult.local_path,
            });
            if (!videoMarkedDone) {
              throw new Error(`Video scene ${sceneIndex} finished without a result URL`);
            }
          }

          if (sceneIndex > 0) {
            const finalVideoUrl = imageNode.data.resultUrl; 
            if (finalVideoUrl) {
              get().addPipelineLog(`Scene ${sceneIndex}: extracting last frame...`);
              try {
                const frameUrl = await extractLastFrame(finalVideoUrl, get().addPipelineLog);
                if (frameUrl) {
                  previousLastFrameUrl = frameUrl;
                  get().updateNodeData(videoNode.id, { lastFrameUrl: frameUrl });
                  get().addPipelineLog(`Scene ${sceneIndex}: last frame extracted and saved for next shot.`);
                } else {
                  throw new Error("extractLastFrame returned null");
                }
              } catch (e) {
                get().updateNodeStatus(videoNode.id, 'error', `Failed to extract last frame: ${e}`);
                throw new Error(`Failed to extract last frame for Scene ${sceneIndex}`);
              }
            }
          }

          continue;
        }

        const imageResult = await createFlowImage({
          prompt: imagePrompt,
          referenceImages,
          node: imageNode,
          filePrefix: get().filePrefix,
          sceneIndex,
          projectUrl: flowProjectUrl,
          createProject: shouldCreateProject,
          onLog: get().addPipelineLog,
        });

        flowProjectUrl = imageResult.project_url || flowProjectUrl;
        shouldCreateProject = false;

        if (!imageResult.result_url) {
          throw new Error(`Image scene ${sceneIndex} finished without a result URL`);
        }

        get().updateNodeData(imageNode.id, {
          resultUrl: imageResult.result_url,
          localPath: imageResult.local_path,
        });
        get().updateNodeStatus(imageNode.id, 'completed');
        get().addPipelineLog(`Scene ${sceneIndex}: image completed.`);
        markStepDone();

        for (const videoNodeBase of videosForImage) {
          const videoNode = get().nodes.find((node) => node.id === videoNodeBase.id);
          if (!videoNode) continue;

          pairedVideoIds.add(videoNode.id);
          const videoPrompt = dataString(videoNode, 'motionPrompt', `Scene ${sceneIndex} motion`);
          get().updateNodeStatus(videoNode.id, 'processing');
          get().addPipelineLog(`Scene ${sceneIndex}: start video node ${videoNode.id}.`);

          const videoResult = await createFlowVideo({
            prompt: videoPrompt,
            sourceImageUrl: imageResult.result_url,
            node: videoNode,
            filePrefix: get().filePrefix,
            sceneIndex,
            projectUrl: flowProjectUrl,
            onLog: get().addPipelineLog,
          });

          flowProjectUrl = videoResult.project_url || flowProjectUrl;

          if (!videoResult.result_url) {
            throw new Error(`Video scene ${sceneIndex} finished without a result URL`);
          }

          get().updateNodeData(videoNode.id, {
            resultUrl: videoResult.result_url,
            localPath: videoResult.local_path,
          });
          get().updateNodeStatus(videoNode.id, 'completed');
          get().addPipelineLog(`Scene ${sceneIndex}: video completed.`);
          markStepDone();

          if (sceneIndex > 0 && videoResult.result_url) {
            get().addPipelineLog(`Scene ${sceneIndex}: extracting last frame...`);
            try {
              const frameUrl = await extractLastFrame(videoResult.result_url, get().addPipelineLog);
              if (frameUrl) {
                previousLastFrameUrl = frameUrl;
                get().updateNodeData(videoNode.id, { lastFrameUrl: frameUrl });
                get().addPipelineLog(`Scene ${sceneIndex}: last frame extracted and saved for next shot.`);
              } else {
                throw new Error("extractLastFrame returned null");
              }
            } catch (e) {
              get().updateNodeStatus(videoNode.id, 'error', `Failed to extract last frame: ${e}`);
              throw new Error(`Failed to extract last frame for Scene ${sceneIndex}`);
            }
          }
        }
      }

      const orphanVideos = videoNodes.filter((node) => !pairedVideoIds.has(node.id));
      if (orphanVideos.length > 0) {
        for (const videoNode of orphanVideos) {
          get().updateNodeStatus(videoNode.id, 'error', 'Video node is not connected to an image node.');
          markStepDone();
        }
        throw new Error('Some video nodes are not connected to image nodes.');
      }

      const completedVideos = sortedByScene(get().nodes.filter((node) => node.type === 'videoGen'));
      const allVideoUrls = completedVideos
        .map((node) => nodeData(node).resultUrl)
        .filter((value): value is string => typeof value === 'string' && value.length > 0);

      if (completedVideos.length > 0 && allVideoUrls.length !== completedVideos.length) {
        throw new Error('Not all video nodes completed. Concat will not start.');
      }

      for (const concatNodeBase of concatNodes) {
        const concatNode = get().nodes.find((node) => node.id === concatNodeBase.id);
        if (!concatNode) continue;

        const concatInputs = findConcatInputs(concatNode.id, get().nodes, initialEdges);
        const videoUrls = concatInputs
          .map((node) => nodeData(node).resultUrl)
          .filter((value): value is string => typeof value === 'string' && value.length > 0);

        if (videoUrls.length !== concatInputs.length || videoUrls.length === 0) {
          throw new Error('Concat node is missing completed video inputs.');
        }

        const bgmUrl = dataString(concatNode, 'bgmUrl', '');
        const autoSubtitles = Boolean(nodeData(concatNode).autoSubtitles);

        get().updateNodeStatus(concatNode.id, 'processing');
        get().addPipelineLog(`Concat started: ${videoUrls.length} video(s).`);
        const concatResult = await concatVideos(videoUrls, get().filePrefix, bgmUrl, autoSubtitles, concatNode.data.topic as string | undefined);

        if (!concatResult.result_url) {
          throw new Error('Concat finished without a result URL');
        }

        get().updateNodeData(concatNode.id, {
          resultUrl: concatResult.result_url,
          localPath: concatResult.local_path,
        });
        get().updateNodeStatus(concatNode.id, 'completed');
        get().addPipelineLog('Concat completed.');
        markStepDone();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Pipeline] Failed:', error);
      get().addPipelineLog(`Pipeline failed: ${message}`);
      for (const node of get().nodes) {
        const status = nodeData(node).status;
        if (status === 'processing') {
          get().updateNodeStatus(node.id, 'error', message);
        }
      }
      throw error;
    } finally {
      get().addPipelineLog('Pipeline stopped.');
      set({ isRunning: false });
    }
  },

  loadFlowFromSupabase: async (projectId: string) => {
    try {
      const { data, error } = await supabase
        .from('projects')
        .select('id, title, react_flow_json')
        .eq('id', projectId)
        .single();

      if (error) throw error;

      if (data?.react_flow_json) {
        const flow = data.react_flow_json as { nodes?: Node[]; edges?: Edge[] };
        const loadedNodes = (flow.nodes || []).map((node) => ({
          ...node,
          data: {
            status: 'waiting' as NodeStatus,
            ...nodeData(node),
            errorMessage: undefined,
          },
        }));

        set({
          nodes: loadedNodes,
          edges: flow.edges || [],
          currentProjectId: projectId,
        });
      }
    } catch (err) {
      console.error('[Store] Failed to load flow:', err);
      alert('Khong the tai flow tu Supabase: ' + (err as Error).message);
    }
  },

  fetchSavedProjects: async () => {
    try {
      const session = await supabase.auth.getSession();
      const userId = session.data.session?.user?.id;
      if (!userId) return;

      const { data, error } = await supabase
        .from('projects')
        .select('id, title, created_at')
        .eq('user_id', userId)
        .not('react_flow_json', 'is', null)
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) throw error;
      set({ savedProjects: data || [] });
    } catch (error) {
      console.error('Error fetching projects:', error);
    }
  },

  applyFilmPlan: (plan: any) => {
    const { nodes, edges } = parseFilmPlanToNodes(plan);
    set({ nodes, edges, currentProjectId: null });
  },

  generateFilmPlan: async (idea: string, settings: any) => {
    const payload = await apiPost<any>('/api/generate/film-plan', { idea, ...settings });
    return payload;
  },
}));
