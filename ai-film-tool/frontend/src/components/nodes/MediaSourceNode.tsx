import { Handle, Position } from '@xyflow/react';

export default function MediaSourceNode({ data }: { data: any }) {
  const getBorderColor = () => {
    switch(data.status) {
      case 'processing': return 'border-orange-500 animate-pulse shadow-[0_0_10px_rgba(249,115,22,0.3)]';
      case 'completed': return 'border-green-500 shadow-[0_0_10px_rgba(34,197,94,0.3)]';
      case 'error': return 'border-red-500';
      default: return 'border-border';
    }
  };

  return (
    <div className={`w-64 bg-card rounded-xl border-2 ${getBorderColor()} shadow-lg overflow-hidden transition-all`}>
      <div className="bg-secondary/50 px-3 py-2 flex items-center justify-between border-b border-border">
        <span className="text-sm font-bold flex items-center gap-2">
          🖼️ Media Source
        </span>
        <div className="flex items-center gap-1">
          {data.status === 'processing' && <span className="text-orange-500 text-xs animate-spin">⚙️</span>}
          {data.status === 'completed' && <span className="text-green-500 text-xs font-bold">✓</span>}
          {data.status === 'error' && <span className="text-red-500 text-xs font-bold">✗</span>}
        </div>
      </div>
      
      <div className="p-3 space-y-3">
        <div className="border-2 border-dashed border-border rounded-lg h-24 flex items-center justify-center text-xs text-muted-foreground hover:bg-secondary/30 cursor-pointer transition-colors overflow-hidden relative">
          {data.image ? (
            <img src={data.image} alt="Reference" className="w-full h-full object-cover" />
          ) : (
            <div className="flex flex-col items-center gap-1">
              <span className="text-lg opacity-50">📷</span>
              <span className="text-[10px]">Click to upload</span>
            </div>
          )}
          {/* Status overlay */}
          {data.status === 'completed' && data.image && (
            <div className="absolute top-1 right-1 bg-green-500 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shadow">✓</div>
          )}
        </div>
        
        <div className="text-xs text-muted-foreground flex justify-between items-center">
          <span className="truncate max-w-[120px]" title={data.topic}>{data.topic || 'No topic'}</span>
          <span className="text-primary font-mono bg-primary/10 px-1 rounded text-[9px]">media-out</span>
        </div>
      </div>

      <Handle 
        type="source" 
        position={Position.Right} 
        id="media-out"
        className="w-3 h-3 bg-primary"
      />
    </div>
  );
}
