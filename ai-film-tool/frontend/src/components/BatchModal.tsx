import { useState } from 'react';
import type { ChangeEvent, Dispatch, DragEvent, SetStateAction } from 'react';
import { useStore } from '../store/useStore';

interface BatchModalProps {
  onClose: () => void;
}

type TextSetter = Dispatch<SetStateAction<string>>;

const edgeStyle = { stroke: '#10b981', strokeWidth: 2 };
const faintEdgeStyle = { stroke: '#10b981', strokeWidth: 2, opacity: 0.5 };
const markerEnd = { type: 'arrowclosed' as any, color: '#10b981' };

export default function BatchModal({ onClose }: BatchModalProps) {
  const { setNodes, setEdges, setFilePrefix: saveFilePrefix } = useStore();

  const [topic, setTopic] = useState('');
  const [filePrefix, setFilePrefix] = useState('FILM');
  const [imagePrompts, setImagePrompts] = useState('');
  const [videoPrompts, setVideoPrompts] = useState('');
  const [imgModel, setImgModel] = useState('Nano Banana');
  const [imgRes, setImgRes] = useState('4k');
  const [imgRatio, setImgRatio] = useState('16:9');
  const [vidModel, setVidModel] = useState('Veo 3');
  const [vidRes, setVidRes] = useState('1080p');
  const [vidRatio, setVidRatio] = useState('16:9');
  const [vidMode, setVidMode] = useState('Frames to Video');
  const [vidDuration, setVidDuration] = useState(8);
  const [voiceover, setVoiceover] = useState(false);
  const [referenceImages, setReferenceImages] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const imageLines = imagePrompts.split('\n').map((line) => line.trim()).filter(Boolean);
  const videoLines = videoPrompts.split('\n').map((line) => line.trim()).filter(Boolean);
  const nodeCount = Math.max(imageLines.length, videoLines.length);

  const handleCreateNodes = () => {
    if (nodeCount === 0) return;

    const batchId = Date.now();
    const prefix = filePrefix.trim() || 'FILM';
    const newNodes: any[] = [];
    const newEdges: any[] = [];
    const concatNodeId = `concat-${batchId}`;

    newNodes.push({
      id: concatNodeId,
      type: 'concat',
      position: { x: 920, y: Math.max(0, (nodeCount - 1) * 140) },
      data: { status: 'waiting', sceneIndex: nodeCount + 1 },
    });

    const refNodeIds = referenceImages.map((image, index) => {
      const id = `ref-${batchId}-${index}`;
      newNodes.push({
        id,
        type: 'mediaSource',
        position: { x: -300, y: index * 150 },
        data: {
          status: 'waiting',
          topic,
          image,
          sceneIndex: index + 1,
        },
      });
      return id;
    });

    for (let index = 0; index < nodeCount; index += 1) {
      const sceneIndex = index + 1;
      const y = index * 280;
      const imageId = `img-${batchId}-${sceneIndex}`;
      const videoId = `vid-${batchId}-${sceneIndex}`;

      newNodes.push({
        id: imageId,
        type: 'imageGen',
        position: { x: 120, y },
        data: {
          status: 'waiting',
          sceneIndex,
          prompt: imageLines[index] || `Image for scene ${sceneIndex}`,
          model: imgModel,
          resolution: imgRes,
          ratio: imgRatio,
        },
      });

      newNodes.push({
        id: videoId,
        type: 'videoGen',
        position: { x: 520, y },
        data: {
          status: 'waiting',
          sceneIndex,
          motionPrompt: videoLines[index] || `Motion for scene ${sceneIndex}`,
          model: vidModel,
          resolution: vidRes,
          ratio: vidRatio,
          mode: vidMode,
          duration: vidDuration,
          voiceover,
        },
      });

      refNodeIds.forEach((refId) => {
        newEdges.push({
          id: `edge-ref-${refId}-${imageId}`,
          source: refId,
          sourceHandle: 'media-out',
          target: imageId,
          targetHandle: 'media-in',
          style: faintEdgeStyle,
          markerEnd,
        });
      });

      newEdges.push({
        id: `edge-image-video-${imageId}-${videoId}`,
        source: imageId,
        sourceHandle: 'media-out',
        target: videoId,
        targetHandle: 'media-in',
        style: edgeStyle,
        markerEnd,
      });

      newEdges.push({
        id: `edge-video-concat-${videoId}-${concatNodeId}`,
        source: videoId,
        sourceHandle: 'video-out',
        target: concatNodeId,
        targetHandle: 'video-in',
        style: edgeStyle,
        markerEnd,
      });
    }

    saveFilePrefix(prefix);
    setNodes(newNodes);
    setEdges(newEdges);
    onClose();
  };

  const handleImageFiles = (files: FileList | null) => {
    if (!files) return;

    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        const value = event.target?.result;
        if (typeof value === 'string') {
          setReferenceImages((current) => [...current, value]);
        }
      };
      reader.readAsDataURL(file);
    });
  };

  const handleTextFile = (event: ChangeEvent<HTMLInputElement>, setter: TextSetter) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      setter(String(loadEvent.target?.result || ''));
    };
    reader.readAsText(file, 'utf-8');
    event.target.value = '';
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(false);
    handleImageFiles(event.dataTransfer.files);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="flex max-h-[95vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-[#1e293b] bg-[#0b101a] shadow-2xl">
        <header className="flex items-center justify-between border-b border-[#1e293b] p-5">
          <div>
            <h2 className="text-lg font-bold uppercase tracking-wide text-white">Cài đặt workflow Google Flow</h2>
            <p className="mt-1 text-xs text-gray-400">Tạo chuỗi ảnh, video và concat phim sau khi toàn bộ video đã xong.</p>
          </div>
          <button onClick={onClose} className="rounded bg-[#151b28] px-3 py-2 text-sm text-gray-300 hover:bg-[#1e293b]">
            Đóng
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_240px]">
            <label className="block">
              <span className="mb-2 block text-xs font-bold uppercase tracking-widest text-[#10b981]">Chủ đề phim</span>
              <input
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                className="w-full rounded-lg border border-[#1e293b] bg-[#111827] px-4 py-3 text-sm text-white outline-none focus:border-[#10b981]"
                placeholder="VD: The lost piglet in a cyber city"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-bold uppercase tracking-widest text-[#10b981]">Tiền tố file</span>
              <input
                value={filePrefix}
                onChange={(event) => setFilePrefix(event.target.value)}
                className="w-full rounded-lg border border-[#1e293b] bg-[#111827] px-4 py-3 text-sm text-white outline-none focus:border-[#10b981]"
                placeholder="FILM"
              />
            </label>
          </div>

          <section className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <div className="rounded-xl border border-[#1e293b] bg-[#111827] p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-widest text-[#10b981]">Ảnh tham chiếu</h3>
                <span className="rounded bg-[#1e293b] px-2 py-1 text-[10px] font-bold text-gray-400">{referenceImages.length} ảnh</span>
              </div>

              <label
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={onDrop}
                className={`flex h-24 cursor-pointer items-center justify-center rounded-lg border-2 border-dashed text-xs font-semibold transition-colors ${
                  isDragging ? 'border-[#10b981] bg-[#10b981]/10 text-[#10b981]' : 'border-[#10b981]/50 text-[#10b981] hover:bg-[#10b981]/5'
                }`}
              >
                <input type="file" accept="image/*" multiple className="hidden" onChange={(event) => handleImageFiles(event.target.files)} />
                Thêm hoặc thả ảnh vào đây
              </label>

              <div className="mt-4 grid max-h-40 grid-cols-3 gap-2 overflow-y-auto">
                {referenceImages.map((image, index) => (
                  <div key={`${image.slice(0, 20)}-${index}`} className="group relative aspect-square overflow-hidden rounded border border-[#1e293b]">
                    <img src={image} alt={`Reference ${index + 1}`} className="h-full w-full object-cover" />
                    <button
                      onClick={() => setReferenceImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                      className="absolute right-1 top-1 rounded bg-red-500 px-1.5 py-0.5 text-[10px] font-bold text-white opacity-0 group-hover:opacity-100"
                    >
                      X
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-[#1e293b] bg-[#111827] p-5">
              <h3 className="mb-4 text-xs font-bold uppercase tracking-widest text-red-400">Cấu hình ảnh</h3>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-[10px] uppercase text-gray-500">Model</span>
                  <select value={imgModel} onChange={(event) => setImgModel(event.target.value)} className="w-full rounded border border-[#1e293b] bg-[#0b101a] px-2 py-2 text-xs text-white">
                    <option>Nano Banana</option>
                    <option>Imagen 4</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[10px] uppercase text-gray-500">Độ phân giải</span>
                  <select value={imgRes} onChange={(event) => setImgRes(event.target.value)} className="w-full rounded border border-[#1e293b] bg-[#0b101a] px-2 py-2 text-xs text-white">
                    <option>1080p</option>
                    <option>4k</option>
                    <option>8k</option>
                  </select>
                </label>
              </div>
              <div className="mt-4 flex rounded border border-[#1e293b] bg-[#0b101a] p-1">
                {['16:9', '9:16'].map((ratio) => (
                  <button key={ratio} onClick={() => setImgRatio(ratio)} className={`flex-1 rounded py-2 text-xs ${imgRatio === ratio ? 'bg-[#10b981] font-bold text-black' : 'text-gray-400'}`}>
                    {ratio}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-[#1e293b] bg-[#111827] p-5">
              <h3 className="mb-4 text-xs font-bold uppercase tracking-widest text-yellow-500">Cấu hình video</h3>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-[10px] uppercase text-gray-500">Model</span>
                  <select value={vidModel} onChange={(event) => setVidModel(event.target.value)} className="w-full rounded border border-[#1e293b] bg-[#0b101a] px-2 py-2 text-xs text-white">
                    <option>Veo 3</option>
                    <option>Omni Flash</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[10px] uppercase text-gray-500">Độ phân giải</span>
                  <select value={vidRes} onChange={(event) => setVidRes(event.target.value)} className="w-full rounded border border-[#1e293b] bg-[#0b101a] px-2 py-2 text-xs text-white">
                    <option>1080p</option>
                    <option>4k</option>
                  </select>
                </label>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <select value={vidRatio} onChange={(event) => setVidRatio(event.target.value)} className="rounded border border-[#1e293b] bg-[#0b101a] px-2 py-2 text-xs text-white">
                  <option>16:9</option>
                  <option>9:16</option>
                </select>
                <select value={vidMode} onChange={(event) => setVidMode(event.target.value)} className="rounded border border-[#1e293b] bg-[#0b101a] px-2 py-2 text-xs text-white">
                  <option>Frames to Video</option>
                  <option>Ingredients to Video</option>
                </select>
              </div>
              <div className="mt-4">
                <div className="mb-2 flex justify-between text-[10px] uppercase text-gray-500">
                  <span>Thời lượng</span>
                  <span className="font-bold text-white">{vidDuration}s</span>
                </div>
                <input type="range" min="4" max="30" value={vidDuration} onChange={(event) => setVidDuration(Number(event.target.value))} className="w-full accent-[#10b981]" />
              </div>
              <label className="mt-4 flex items-center gap-2 text-xs text-gray-300">
                <input type="checkbox" checked={voiceover} onChange={(event) => setVoiceover(event.target.checked)} className="accent-[#10b981]" />
                Bật voice/audio nếu Flow hỗ trợ
              </label>
            </div>
          </section>

          <section className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-widest text-red-400">Prompt tạo ảnh</h3>
                <label className="cursor-pointer rounded border border-red-500/20 bg-red-500/10 px-3 py-1 text-[10px] font-bold text-red-400">
                  Tải .txt
                  <input type="file" accept=".txt" className="hidden" onChange={(event) => handleTextFile(event, setImagePrompts)} />
                </label>
              </div>
              <textarea
                value={imagePrompts}
                onChange={(event) => setImagePrompts(event.target.value)}
                className="h-52 w-full resize-none rounded-xl border border-[#1e293b] bg-[#111827] p-4 text-sm leading-relaxed text-gray-200 outline-none focus:border-[#10b981]"
                placeholder="Mỗi dòng là prompt tạo ảnh cho một cảnh..."
              />
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-widest text-yellow-500">Prompt tạo video</h3>
                <label className="cursor-pointer rounded border border-yellow-500/20 bg-yellow-500/10 px-3 py-1 text-[10px] font-bold text-yellow-500">
                  Tải .txt
                  <input type="file" accept=".txt" className="hidden" onChange={(event) => handleTextFile(event, setVideoPrompts)} />
                </label>
              </div>
              <textarea
                value={videoPrompts}
                onChange={(event) => setVideoPrompts(event.target.value)}
                className="h-52 w-full resize-none rounded-xl border border-[#1e293b] bg-[#111827] p-4 text-sm leading-relaxed text-gray-200 outline-none focus:border-[#10b981]"
                placeholder="Mỗi dòng là prompt chuyển động cho video cùng cảnh..."
              />
            </div>
          </section>
        </div>

        <footer className="flex items-center justify-between border-t border-[#1e293b] p-5">
          <span className="text-xs text-gray-400">
            Sẽ tạo {nodeCount} cảnh. Mỗi cảnh chạy tuần tự: ảnh xong mới tạo video.
          </span>
          <button
            onClick={handleCreateNodes}
            disabled={nodeCount === 0}
            className={`rounded px-6 py-3 text-sm font-bold ${nodeCount > 0 ? 'bg-[#10b981] text-black hover:bg-[#10b981]/90' : 'bg-[#10b981]/20 text-[#10b981]/50'}`}
          >
            Tạo workflow
          </button>
        </footer>
      </div>
    </div>
  );
}
