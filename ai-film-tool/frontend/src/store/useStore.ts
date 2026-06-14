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
  error?: string;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

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

function collectReferenceImages(nodes: Node[]) {
  return sortedByScene(nodes)
    .filter((node) => node.type === 'mediaSource')
    .map((node) => nodeData(node).image)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
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

async function createFlowImage(params: {
  prompt: string;
  referenceImages: string[];
  node: Node;
  filePrefix: string;
  sceneIndex: number;
}) {
  return apiPost<GenerateResponse>('/api/generate/flow-image', {
    prompt: params.prompt,
    referenceImages: params.referenceImages,
    filePrefix: params.filePrefix,
    sceneIndex: params.sceneIndex,
    profile: 'default',
    options: {
      model: dataString(params.node, 'model'),
      resolution: dataString(params.node, 'resolution'),
      ratio: dataString(params.node, 'ratio'),
    },
  });
}

async function createFlowVideo(params: {
  prompt: string;
  sourceImageUrl: string;
  node: Node;
  filePrefix: string;
  sceneIndex: number;
}) {
  return apiPost<GenerateResponse>('/api/generate/flow-video', {
    prompt: params.prompt,
    sourceImageUrl: params.sourceImageUrl,
    filePrefix: params.filePrefix,
    sceneIndex: params.sceneIndex,
    profile: 'default',
    options: {
      model: dataString(params.node, 'model'),
      resolution: dataString(params.node, 'resolution'),
      ratio: dataString(params.node, 'ratio'),
      mode: dataString(params.node, 'mode'),
      duration: nodeData(params.node).duration,
      voiceover: nodeData(params.node).voiceover,
    },
  });
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
    });

    let completed = 0;
    const markStepDone = () => {
      completed += 1;
      set({ pipelineProgress: { completed, total: totalSteps } });
    };

    try {
      const referenceImages = collectReferenceImages(get().nodes);
      const pairedVideoIds = new Set<string>();

      for (const mediaNode of mediaNodes) {
        get().updateNodeStatus(mediaNode.id, 'completed');
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

        get().updateNodeStatus(imageNode.id, 'processing');

        const imageResult = await createFlowImage({
          prompt: imagePrompt,
          referenceImages,
          node: imageNode,
          filePrefix: get().filePrefix,
          sceneIndex,
        });

        if (!imageResult.result_url) {
          throw new Error(`Image scene ${sceneIndex} finished without a result URL`);
        }

        get().updateNodeData(imageNode.id, {
          resultUrl: imageResult.result_url,
          localPath: imageResult.local_path,
        });
        get().updateNodeStatus(imageNode.id, 'completed');
        markStepDone();

        const videosForImage = findConnectedVideos(imageNode.id, get().nodes, initialEdges);
        for (const videoNodeBase of videosForImage) {
          const videoNode = get().nodes.find((node) => node.id === videoNodeBase.id);
          if (!videoNode) continue;

          pairedVideoIds.add(videoNode.id);
          const videoPrompt = dataString(videoNode, 'motionPrompt', `Scene ${sceneIndex} motion`);
          get().updateNodeStatus(videoNode.id, 'processing');

          const videoResult = await createFlowVideo({
            prompt: videoPrompt,
            sourceImageUrl: imageResult.result_url,
            node: videoNode,
            filePrefix: get().filePrefix,
            sceneIndex,
          });

          if (!videoResult.result_url) {
            throw new Error(`Video scene ${sceneIndex} finished without a result URL`);
          }

          get().updateNodeData(videoNode.id, {
            resultUrl: videoResult.result_url,
            localPath: videoResult.local_path,
          });
          get().updateNodeStatus(videoNode.id, 'completed');
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
        const concatResult = await concatVideos(videoUrls, get().filePrefix);

        if (!concatResult.result_url) {
          throw new Error('Concat finished without a result URL');
        }

        get().updateNodeData(concatNode.id, {
          resultUrl: concatResult.result_url,
          localPath: concatResult.local_path,
        });
        get().updateNodeStatus(concatNode.id, 'completed');
        markStepDone();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Pipeline] Failed:', error);
      for (const node of get().nodes) {
        const status = nodeData(node).status;
        if (status === 'processing') {
          get().updateNodeStatus(node.id, 'error', message);
        }
      }
      throw error;
    } finally {
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
