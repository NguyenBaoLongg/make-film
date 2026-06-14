import { Handle, Position } from '@xyflow/react';
import { useStore } from '../../store/useStore';

export default function ImageGenNode({ id, data }: { id: string; data: any }) {
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
    a.download = `image_${Date.now()}.jpg`;
    a.target = '_blank';
    a.click();
  };

  return (
    <div className={`w-72 bg-card rounded-xl border-2 ${getBorderColor()} shadow-lg overflow-hidden transition-all`}>
      <Handle type="target" position={Position.Left} id="media-in" className="w-3 h-3 bg-secondary top-1/4" />
      <Handle type="target" position={Position.Left} id="prompt-in" className="w-3 h-3 bg-accent top-3/4" />
      
      <div className="bg-secondary/50 px-3 py-2 flex items-center justify-between border-b border-border">
        <span className="text-sm font-bold flex items-center gap-2">
          🎨 Image Gen
        </span>
        <div className="flex items-center gap-1">
          {data.status === 'processing' && <span className="text-orange-500 text-xs animate-spin">⚙️</span>}
          {data.status === 'completed' && <span className="text-green-500 text-xs font-bold">✓</span>}
          {data.status === 'error' && <span className="text-red-500 text-xs font-bold">✗</span>}
          {data.model && <span className="text-[9px] bg-primary/10 text-primary px-1.5 py-0.5 rounded font-mono">{data.model}</span>}
        </div>
      </div>
      
      <div className="p-3 space-y-2">
        {/* Processing Animation */}
        {data.status === 'processing' && (
          <div className="border-2 border-dashed border-orange-500/50 rounded-lg h-24 flex flex-col items-center justify-center bg-orange-500/5">
            <div className="flex gap-1 mb-2">
              <div className="w-2 h-2 bg-orange-500 rounded-full animate-bounce" style={{animationDelay: '0ms'}}></div>
              <div className="w-2 h-2 bg-orange-500 rounded-full animate-bounce" style={{animationDelay: '150ms'}}></div>
              <div className="w-2 h-2 bg-orange-500 rounded-full animate-bounce" style={{animationDelay: '300ms'}}></div>
            </div>
            <span className="text-orange-500 text-[10px] font-semibold">Đang tạo ảnh...</span>
          </div>
        )}

        {/* Result Image */}
        {data.resultUrl && data.status === 'completed' && (
          <div className="rounded-lg overflow-hidden border border-green-500/30 relative group">
            <img src={data.resultUrl} alt="Generated" className="w-full h-auto" />
            <button 
              onClick={handleDownload}
              className="absolute bottom-1 right-1 bg-black/70 text-white text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-primary"
            >
              💾 Tải ảnh
            </button>
          </div>
        )}

        {/* Prompt */}
        {data.status !== 'processing' && !data.resultUrl && (
          <>
            <div>
              <label className="text-[10px] text-muted-foreground block mb-1 uppercase tracking-wider">Prompt</label>
              <textarea 
                className="w-full bg-input border border-border rounded px-2 py-1 text-xs outline-none focus:border-primary resize-none h-14"
                placeholder="A beautiful scene..."
                value={data.prompt || ""}
                onChange={(event) => updateNodeData(id, { prompt: event.target.value })}
              />
            </div>
          </>
        )}

        {data.errorMessage && data.status === 'error' && (
          <p className="rounded bg-red-500/10 p-2 text-[10px] text-red-400">{data.errorMessage}</p>
        )}

        {/* Info footer */}
        {data.resolution && (
          <div className="flex gap-1 flex-wrap">
            <span className="text-[9px] bg-secondary px-1.5 py-0.5 rounded text-muted-foreground">{data.resolution}</span>
            {data.ratio && <span className="text-[9px] bg-secondary px-1.5 py-0.5 rounded text-muted-foreground">{data.ratio}</span>}
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Right} id="media-out" className="w-3 h-3 bg-primary" />
    </div>
  );
}
