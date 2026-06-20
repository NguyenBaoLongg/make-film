import { Handle, Position } from '@xyflow/react';
import { useStore } from '../../store/useStore';

export default function ConcatNode({ id, data }: { id: string; data: any }) {
  const updateNodeData = useStore((state) => state.updateNodeData);
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

        {/* Settings */}
        {data.status !== 'processing' && (
          <div className="mt-4 border-t border-border pt-3 space-y-3">
            <div>
              <label className="text-[10px] text-muted-foreground block mb-1 uppercase tracking-wider">Chọn kho nhạc có sẵn</label>
              <select 
                className="w-full bg-input border border-border rounded px-2 py-1 text-xs outline-none focus:border-primary"
                onChange={(event) => {
                  if (event.target.value) {
                    updateNodeData(id, { bgmUrl: event.target.value });
                  }
                }}
                defaultValue=""
              >
                <option value="" disabled>--- Chọn nhạc hoạt hình ---</option>
                <option value="https://upload.wikimedia.org/wikipedia/commons/4/4b/Kevin_MacLeod_-_Fluffing_a_Duck.ogg">🦆 Fluffing a Duck (Vui nhộn, lạch bạch)</option>
                <option value="https://upload.wikimedia.org/wikipedia/commons/6/69/Kevin_MacLeod_-_Monkeys_Spinning_Monkeys.ogg">🐒 Monkeys Spinning Monkeys (Tinh nghịch, lén lút)</option>
                <option value="https://upload.wikimedia.org/wikipedia/commons/9/91/Kevin_MacLeod_-_The_Builder.ogg">🔨 The Builder (Xây dựng, tò mò)</option>
              </select>
            </div>
            
            <div>
              <label className="text-[10px] text-muted-foreground block mb-1 uppercase tracking-wider">Hoặc Nhập Nhạc Nền (BGM URL)</label>
              <input 
                type="text"
                className="w-full bg-input border border-border rounded px-2 py-1 text-xs outline-none focus:border-primary"
                placeholder="https://.../audio.mp3"
                value={data.bgmUrl || ""}
                onChange={(event) => updateNodeData(id, { bgmUrl: event.target.value })}
              />
              <p className="text-[9px] text-muted-foreground mt-1">Hỗ trợ các định dạng MP3, WAV hoặc link OGG.</p>
            </div>

            <div className="pt-2 border-t border-border">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="accent-primary w-3 h-3"
                  checked={data.autoSubtitles || false}
                  onChange={(e) => updateNodeData(id, { autoSubtitles: e.target.checked })}
                />
                <span className="text-xs text-muted-foreground">Tự động nghe và tạo phụ đề (Whisper)</span>
              </label>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
