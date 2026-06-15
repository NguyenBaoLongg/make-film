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

function makeRunId(path: string, sceneIndex?: number) {
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${path.replace(/[^a-z0-9]+/gi, '-')}-${sceneIndex || 0}-${suffix}`;
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
}) {
  return apiPostWithLog<GenerateResponse>('/api/generate/flow-scene', {
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
  }, params.onLog, params.sceneIndex);
}

async function concatVideos(videoUrls: string[], filePrefix: string) {
  return apiPost<GenerateResponse>('/api/generate/concat-videos', {
    videoUrls,
    filePrefix,
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

      for (let index = 0; index < imageNodes.length; index += 1) {
        const imageNode = get().nodes.find((node) => node.id === imageNodes[index].id);
        if (!imageNode) continue;

        const sceneIndex = dataNumber(imageNode, 'sceneIndex', index + 1);
        const imagePrompt = dataString(imageNode, 'prompt', `Scene ${sceneIndex} image`);
        const referenceImages = collectConnectedImageInputs(imageNode.id, get().nodes, initialEdges);
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
          });

          flowProjectUrl = sceneResult.project_url || flowProjectUrl;
          shouldCreateProject = false;

          const imageUrl = sceneResult.image_result_url || sceneResult.result_url;
          if (!imageUrl) {
            throw new Error(`Image scene ${sceneIndex} finished without a result URL`);
          }

          get().updateNodeData(imageNode.id, {
            resultUrl: imageUrl,
            localPath: sceneResult.image_local_path,
          });
          get().updateNodeStatus(imageNode.id, 'completed');
          get().addPipelineLog(`Scene ${sceneIndex}: image completed.`);
          markStepDone();

          get().updateNodeStatus(videoNode.id, 'processing');
          const videoUrl = sceneResult.video_result_url || sceneResult.result_url;
          if (!videoUrl) {
            throw new Error(`Video scene ${sceneIndex} finished without a result URL`);
          }

          get().updateNodeData(videoNode.id, {
            resultUrl: videoUrl,
            localPath: sceneResult.video_local_path || sceneResult.local_path,
          });
          get().updateNodeStatus(videoNode.id, 'completed');
          get().addPipelineLog(`Scene ${sceneIndex}: video completed.`);
          markStepDone();
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

        get().updateNodeStatus(concatNode.id, 'processing');
        get().addPipelineLog(`Concat started: ${videoUrls.length} video(s).`);
        const concatResult = await concatVideos(videoUrls, get().filePrefix);

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
            ...nodeData(node),
            status: 'waiting' as NodeStatus,
            resultUrl: undefined,
            localPath: undefined,
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
    } catch (err) {
      console.error('[Store] Failed to fetch projects:', err);
    }
  },
}));
