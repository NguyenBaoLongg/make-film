import { Handle, Position } from '@xyflow/react';
import { useStore } from '../../store/useStore';

export default function VideoGenNode({ id, data }: { id: string; data: any }) {
  const updateNodeData = useStore((state) => state.updateNodeData);

  const getBorderColor = () => {
    switch(data.status) {
      case 'processing': return 'border-orange-500 animate-[pulse_1s_ease-in-out_infinite] shadow-[0_0_15px_rgba(249,115,22,0.5)]';
      case 'completed': return 'border-green-500 shadow-[0_0_10px_rgba(34,197,94,0.3)]';
      case 'error': return 'border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.3)]';
      default: return 'border-border';
    }
  };

  const handleDownload = () => {
    if (!data.resultUrl) return;
    const a = document.createElement('a');
    a.href = data.resultUrl;
    a.download = `video_${Date.now()}.mp4`;
    a.target = '_blank';
    a.click();
  };

  return (
    <div className={`w-72 bg-card rounded-xl border-2 ${getBorderColor()} shadow-lg overflow-hidden transition-all`}>
      <Handle type="target" position={Position.Left} id="media-in" className="w-3 h-3 bg-primary" />
      
      <div className="bg-secondary/50 px-3 py-2 flex items-center justify-between border-b border-border">
        <span className="text-sm font-bold flex items-center gap-2">
          🎬 Video Gen
        </span>
        <div className="flex items-center gap-1">
          {data.status === 'processing' && <span className="text-orange-500 text-xs animate-spin">⚙️</span>}
          {data.status === 'completed' && <span className="text-green-500 text-xs font-bold">✓</span>}
          {data.status === 'error' && <span className="text-red-500 text-xs font-bold">✗</span>}
          {data.mode && <span className="text-[9px] bg-yellow-500/10 text-yellow-500 px-1.5 py-0.5 rounded font-mono">{data.mode}</span>}
        </div>
      </div>
      
      <div className="p-3 space-y-2">
        {/* Processing Animation */}
        {data.status === 'processing' && (
          <div className="border-2 border-dashed border-orange-500/50 rounded-lg p-4 bg-orange-500/5">
            <div className="flex items-center justify-center gap-2 mb-2">
              <span className="text-orange-500 text-lg animate-spin">🎬</span>
              <span className="text-orange-500 text-[10px] font-semibold">Đang tạo video...</span>
            </div>
            <div className="w-full bg-secondary rounded-full h-1.5">
              <div className="bg-orange-500 h-1.5 rounded-full animate-pulse w-2/3"></div>
            </div>
          </div>
        )}

        {/* Result Video */}
        {data.resultUrl && data.status === 'completed' && (
          <div className="rounded-lg overflow-hidden border border-green-500/30 relative group">
            <video src={data.resultUrl} controls className="w-full h-auto" />
            <button 
              onClick={handleDownload}
              className="absolute bottom-1 right-1 bg-black/70 text-white text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-primary"
            >
              💾 Tải video
            </button>
          </div>
        )}

        {/* Motion Prompt */}
        {data.status !== 'processing' && !data.resultUrl && (
          <div className="space-y-2">
            <div>
              <label className="text-[10px] text-muted-foreground block mb-1 uppercase tracking-wider">Motion Prompt</label>
              <input 
                type="text"
                className="w-full bg-input border border-border rounded px-2 py-1 text-xs outline-none focus:border-primary"
                placeholder="Slow pan, dramatic lighting..."
                value={data.motionPrompt || ""}
                onChange={(event) => updateNodeData(id, { motionPrompt: event.target.value })}
              />
            </div>
          </div>
        )}

        {data.errorMessage && data.status === 'error' && (
          <p className="rounded bg-red-500/10 p-2 text-[10px] text-red-400">{data.errorMessage}</p>
        )}

        {/* Info footer */}
        <div className="flex gap-1 flex-wrap">
          {data.duration && <span className="text-[9px] bg-secondary px-1.5 py-0.5 rounded text-muted-foreground">{data.duration}s</span>}
          {data.resolution && <span className="text-[9px] bg-secondary px-1.5 py-0.5 rounded text-muted-foreground">{data.resolution}</span>}
          {data.ratio && <span className="text-[9px] bg-secondary px-1.5 py-0.5 rounded text-muted-foreground">{data.ratio}</span>}
          {data.voiceover && <span className="text-[9px] bg-yellow-500/10 text-yellow-500 px-1.5 py-0.5 rounded">🗣️ AI Voice</span>}
        </div>
      </div>

      <Handle type="source" position={Position.Right} id="video-out" className="w-3 h-3 bg-red-500" />
    </div>
  );
}
