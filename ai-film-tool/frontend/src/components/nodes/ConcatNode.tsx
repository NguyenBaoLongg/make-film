import { Handle, Position } from '@xyflow/react';

export default function ConcatNode({ data }: { data: any }) {
  const getBorderColor = () => {
    switch (data.status) {
      case 'processing': return 'border-orange-500 animate-[pulse_1s_ease-in-out_infinite] shadow-[0_0_15px_rgba(249,115,22,0.5)]';
      case 'completed': return 'border-green-500 shadow-[0_0_20px_rgba(34,197,94,0.4)]';
      case 'error': return 'border-red-500';
      default: return 'border-border';
    }
  };

  const handleDownload = () => {
    if (!data.resultUrl) return;
    const link = document.createElement('a');
    link.href = data.resultUrl;
    link.download = `final_render_${Date.now()}.mp4`;
    link.target = '_blank';
    link.click();
  };

  return (
    <div className={`w-72 overflow-hidden rounded-xl border-2 bg-card shadow-lg transition-all ${getBorderColor()}`}>
      <Handle type="target" position={Position.Left} id="video-in" className="top-1/2 h-3 w-3 bg-red-500" />

      <div className="flex items-center justify-between border-b border-border bg-secondary/50 px-3 py-2">
        <span className="text-sm font-bold">FFmpeg Concat</span>
        {data.status === 'processing' && <span className="text-xs text-orange-500">Running</span>}
        {data.status === 'completed' && <span className="text-xs font-bold text-green-500">Done</span>}
        {data.status === 'error' && <span className="text-xs font-bold text-red-500">Error</span>}
      </div>

      <div className="space-y-3 p-4">
        {data.status === 'completed' && data.resultUrl ? (
          <>
            <video src={data.resultUrl} controls className="w-full rounded border border-green-500/30" />
            <button
              onClick={handleDownload}
              className="w-full rounded bg-primary px-4 py-2 text-xs font-bold text-primary-foreground hover:bg-primary/90"
            >
              Download final MP4
            </button>
          </>
        ) : data.status === 'processing' ? (
          <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-4 text-center text-xs font-semibold text-orange-500">
            Đang ghép toàn bộ video...
          </div>
        ) : data.status === 'error' ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-400">
            {data.errorMessage || 'Render thất bại'}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            Chỉ bắt đầu ghép sau khi tất cả video node đã tải về thành công.
          </div>
        )}
      </div>
    </div>
  );
}
