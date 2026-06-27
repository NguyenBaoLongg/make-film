import { useCallback, useEffect, useState } from 'react';
import type { DragEvent } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useReactFlow,
  ReactFlowProvider,
  BackgroundVariant
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useStore } from '../store/useStore';
import { supabase } from '../lib/supabase';
import BatchModal from '../components/BatchModal';
import ChromeManager from '../components/ChromeManager';
import { AutoFilmStudioPanel } from '../components/AutoFilmStudioPanel';

import MediaSourceNode from '../components/nodes/MediaSourceNode';
import ImageGenNode from '../components/nodes/ImageGenNode';
import VideoGenNode from '../components/nodes/VideoGenNode';
import ConcatNode from '../components/nodes/ConcatNode';

const nodeTypes = {
  mediaSource: MediaSourceNode,
  imageGen: ImageGenNode,
  videoGen: VideoGenNode,
  concat: ConcatNode,
};

function FlowCanvas() {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect } = useStore();
  const { screenToFlowPosition } = useReactFlow();

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/reactflow');
      if (!type) return;

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const newNode = {
        id: `${type}-${Date.now()}`,
        type,
        position,
        data: { label: `${type} node`, status: 'waiting' },
      };

      useStore.getState().setNodes([...nodes, newNode]);
    },
    [nodes, screenToFlowPosition]
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      nodeTypes={nodeTypes}
      onDrop={onDrop}
      onDragOver={onDragOver}
      fitView
      className="bg-background"
    >
      <Background variant={BackgroundVariant.Dots} gap={12} size={1} color="#10b98140" />
      <Controls className="bg-card border border-border fill-foreground text-foreground" />
      <MiniMap
        nodeColor="#10b981"
        maskColor="#070b14aa"
        className="bg-card border border-border"
      />
    </ReactFlow>
  );
}

// ============================================================
// Load Flow Dropdown Component
// ============================================================
function LoadFlowDropdown({ onClose }: { onClose: () => void }) {
  const { savedProjects, fetchSavedProjects, loadFlowFromSupabase } = useStore();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSavedProjects().then(() => setLoading(false));
  }, []);

  const handleSelect = async (projectId: string) => {
    await loadFlowFromSupabase(projectId);
    onClose();
  };

  return (
    <div className="absolute top-14 right-4 z-50 w-80 bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <span className="text-sm font-bold text-primary flex items-center gap-2">📂 Saved Workflows</span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xs">✕</button>
      </div>
      <div className="max-h-64 overflow-y-auto">
        {loading ? (
          <div className="p-4 text-center text-muted-foreground text-sm">
            <span className="animate-spin inline-block mr-2">⏳</span>Đang tải...
          </div>
        ) : savedProjects.length === 0 ? (
          <div className="p-4 text-center text-muted-foreground text-sm">
            Chưa có workflow nào được lưu.
          </div>
        ) : (
          savedProjects.map((p) => (
            <button
              key={p.id}
              onClick={() => handleSelect(p.id)}
              className="w-full text-left px-4 py-3 hover:bg-secondary/50 border-b border-border/50 transition-colors group"
            >
              <div className="text-sm font-medium text-foreground group-hover:text-primary truncate">
                {p.title}
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">
                {new Date(p.created_at).toLocaleString('vi-VN')}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ============================================================
// Main Workspace
// ============================================================
export default function Workspace() {
  const {
    concurrency, setConcurrency, filePrefix, setFilePrefix,
    isRunning, runPipeline, pipelineProgress, pipelineLogs, nodes
  } = useStore();
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [showLoadFlow, setShowLoadFlow] = useState(false);
  const [showChromeManager, setShowChromeManager] = useState(false);
  const [showAutoFilmStudio, setShowAutoFilmStudio] = useState(false);

  const handleRunPipeline = () => {
    runPipeline().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      alert(`Pipeline stopped: ${message}`);
    });
  };

  const onDragStart = (event: DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  const handleBatch = () => {
    setShowBatchModal(true);
  };

  const handleSaveToSupabase = async () => {
    const state = useStore.getState();
    const payload = {
      nodes: state.nodes,
      edges: state.edges
    };

    try {
      const user = (await supabase.auth.getSession()).data.session?.user;
      if (!user) return alert("Please login first");

      const { error } = await supabase.from('projects').insert([{
        user_id: user.id,
        title: `Workflow ${new Date().toLocaleString('vi-VN')}`,
        react_flow_json: payload,
        status: 'draft',
        progress: 0
      }]);

      if (error) throw error;
      alert("✅ Đã lưu workflow thành công!");
    } catch (err: any) {
      alert("❌ Lỗi lưu: " + err.message);
    }
  };

  const handleExportJSON = () => {
    const state = useStore.getState();
    const payload = {
      id: 'ws_default',
      name: 'Workflow chính',
      nodes: state.nodes,
      edges: state.edges
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workflow_export_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Progress percentage
  const progressPct = pipelineProgress.total > 0
    ? Math.round((pipelineProgress.completed / pipelineProgress.total) * 100)
    : 0;

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground overflow-hidden">
      {/* Top Header */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card px-4 relative">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-bold text-primary">AI Film Studio Pro</h1>
          <div className="h-6 w-px bg-border"></div>
          <div className="flex gap-2">
            <button className="px-3 py-1 bg-background text-sm font-medium border border-border rounded">
              Workflow 1
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Pipeline Progress */}
          {isRunning && (
            <div className="flex items-center gap-2 bg-orange-500/10 border border-orange-500/30 rounded-lg px-3 py-1">
              <span className="text-orange-500 text-xs animate-spin">⚙️</span>
              <div className="w-24 bg-secondary rounded-full h-1.5">
                <div
                  className="bg-orange-500 h-1.5 rounded-full transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="text-orange-500 text-[10px] font-mono font-bold min-w-[3ch]">
                {progressPct}%
              </span>
            </div>
          )}

          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Prefix:</span>
            <input
              type="text"
              value={filePrefix}
              onChange={(e) => setFilePrefix(e.target.value)}
              className="w-28 bg-input border border-border px-2 py-1 rounded outline-none focus:border-primary text-xs"
            />
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Threads:</span>
            <select
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              className="bg-input border border-border px-2 py-1 rounded outline-none focus:border-primary text-xs"
            >
              {[2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>

          <div className="h-6 w-px bg-border"></div>

          <button
            onClick={() => setShowLoadFlow(!showLoadFlow)}
            className="text-xs font-medium hover:text-primary flex items-center gap-1 px-2 py-1 bg-secondary/50 rounded border border-border hover:border-primary transition-colors"
          >
            📂 Load
          </button>
          <button onClick={handleSaveToSupabase} className="text-xs font-medium hover:text-primary flex items-center gap-1 px-2 py-1 bg-secondary/50 rounded border border-border hover:border-primary transition-colors">
            💾 Save
          </button>
          <button onClick={handleExportJSON} className="text-xs font-medium hover:text-primary flex items-center gap-1 px-2 py-1 bg-secondary/50 rounded border border-border hover:border-primary transition-colors">
            📤 Export
          </button>

          <div className="h-6 w-px bg-border mx-1"></div>

          <button 
            onClick={() => setShowAutoFilmStudio(true)}
            className="px-4 py-1.5 text-sm font-bold rounded flex items-center gap-2 transition-all bg-indigo-600 text-white hover:bg-indigo-700 shadow-[0_0_15px_rgba(79,70,229,0.4)]"
          >
            ✨ Auto Studio
          </button>

          <button
            onClick={handleRunPipeline}
            disabled={isRunning || nodes.length === 0}
            className={`px-4 py-1.5 text-sm font-bold rounded flex items-center gap-2 transition-all ${isRunning
                ? 'bg-orange-500/20 text-orange-500 cursor-not-allowed border border-orange-500/30'
                : nodes.length === 0
                  ? 'bg-primary/20 text-primary/50 cursor-not-allowed'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_15px_rgba(16,185,129,0.3)]'
              }`}
          >
            {isRunning ? (
              <>
                <span className="animate-spin">⚙️</span>
                Running {progressPct}%
              </>
            ) : (
              <>▶ Run Pipeline</>
            )}
          </button>
        </div>

        {/* Load Flow Dropdown */}
        {showLoadFlow && <LoadFlowDropdown onClose={() => setShowLoadFlow(false)} />}
      </header>

      {/* Main Area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Toolbar */}
        <aside className="w-16 shrink-0 border-r border-border bg-card flex flex-col items-center py-4 gap-4 z-10 shadow-lg">
          <div
            className="w-10 h-10 bg-secondary border border-border rounded flex items-center justify-center cursor-grab hover:border-primary"
            onDragStart={(event) => onDragStart(event, 'mediaSource')}
            draggable
            title="Media Source Node"
          >
            🖼️
          </div>
          <div
            className="w-10 h-10 bg-secondary border border-border rounded flex items-center justify-center cursor-grab hover:border-primary"
            onDragStart={(event) => onDragStart(event, 'imageGen')}
            draggable
            title="Image Gen Node"
          >
            🎨
          </div>
          <div
            className="w-10 h-10 bg-secondary border border-border rounded flex items-center justify-center cursor-grab hover:border-primary"
            onDragStart={(event) => onDragStart(event, 'videoGen')}
            draggable
            title="Video Gen Node"
          >
            🎬
          </div>
          <div
            className="w-10 h-10 bg-secondary border border-border rounded flex items-center justify-center cursor-grab hover:border-primary"
            onDragStart={(event) => onDragStart(event, 'concat')}
            draggable
            title="Concat Node"
          >
            ✂️
          </div>

          <div className="w-8 h-px bg-border my-2"></div>

          <button
            onClick={handleBatch}
            className="w-10 h-10 bg-accent text-accent-foreground rounded flex items-center justify-center cursor-pointer hover:bg-accent/80 font-bold text-xs text-center leading-tight"
            title="Batch Combined"
          >
            BATCH
          </button>

          <button
            onClick={() => setShowChromeManager(true)}
            className="w-10 h-10 bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded flex items-center justify-center cursor-pointer hover:bg-blue-500/30 hover:border-blue-500/50 transition-colors"
            title="Quản lý Chrome Profile"
          >
            🌐
          </button>
        </aside>

        {/* Canvas */}
        <main className="flex-1 h-full relative">
          <ReactFlowProvider>
            <FlowCanvas />
          </ReactFlowProvider>
        </main>
      </div>

      {/* Đã ẩn pipeline log theo yêu cầu
      {pipelineLogs.length > 0 && (
        <div className="absolute bottom-4 right-4 z-40 flex max-h-80 w-[520px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-border bg-card/95 shadow-2xl backdrop-blur">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-bold uppercase tracking-wider text-primary">Pipeline log</span>
            <span className="text-[10px] text-muted-foreground">{pipelineLogs.length} lines</span>
          </div>
          <div className="flex-1 space-y-1 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {pipelineLogs.slice(-120).map((line, index) => (
              <div key={`${index}-${line}`} className="whitespace-pre-wrap break-words">
                {line}
              </div>
            ))}
          </div>
        </div>
      )}
      */}

      {showBatchModal && <BatchModal onClose={() => setShowBatchModal(false)} />}
      {showChromeManager && <ChromeManager onClose={() => setShowChromeManager(false)} />}
      {showAutoFilmStudio && <AutoFilmStudioPanel onClose={() => setShowAutoFilmStudio(false)} />}
    </div>
  );
}
