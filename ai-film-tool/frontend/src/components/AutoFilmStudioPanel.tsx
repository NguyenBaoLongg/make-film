import { useState } from 'react';
import { useStore } from '../store/useStore';
import { supabase } from '../lib/supabase';

const STYLE_PRESETS = [
  { id: 'netflix', label: '🎬 Điện ảnh Netflix', style: 'Netflix original series aesthetic, Arri Alexa 65, moody cinematic color grading, hyper-detailed, photorealistic, cinematic lighting' },
  { id: 'blind_box', label: '🧸 3D Art Toy', style: 'Popmart blind box style, cute chibi 3D character, glossy plastic material, studio lighting, octane render, trending on artstation' },
  { id: 'dark_fantasy', label: '⚔️ Dark Fantasy', style: 'Dark fantasy aesthetic, grimdark, 8k resolution, Unreal Engine 5 render, dramatic chiaroscuro lighting, intricate details, epic' },
  { id: 'cyberpunk', label: '🌃 Cyberpunk', style: 'Cyberpunk aesthetic, neon lighting, gritty sci-fi, rainy city, hyper-realistic, 8k, Ray tracing, cinematic' },
  { id: 'retro_anime', label: '📼 90s Retro Anime', style: '1990s retro anime style, VHS aesthetic, cel shading, vintage color palette, nostalgic, highly detailed background' },
  { id: 'pixar', label: '🎈 3D Pixar', style: 'Pixar 3D animation style, rounded toy-like characters, soft subsurface lighting, vibrant pastel colors, cinematic composition, high-quality 3D render' },
  { id: 'anime', label: '🌸 Anime', style: 'High quality Japanese anime style, Studio Ghibli, beautiful background, cel shading, vibrant colors' },
  { id: 'custom', label: '✏️ Tùy chỉnh', style: '' }
];

export function AutoFilmStudioPanel({ onClose }: { onClose: () => void }) {
  const generateFilmPlan = useStore((s) => s.generateFilmPlan);
  const applyFilmPlan = useStore((s) => s.applyFilmPlan);
  const runPipeline = useStore((s) => s.runPipeline);

  const [idea, setIdea] = useState('');
  const [duration, setDuration] = useState('60');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [language, setLanguage] = useState('Vietnamese');
  
  const [activeStyleId, setActiveStyleId] = useState('pixar');
  const [style, setStyle] = useState(STYLE_PRESETS[0].style);
  const [videoStyle, setVideoStyle] = useState('Smooth Pixar-quality 3D animation, fluid character movement, cinematic camera, no style shift');
  
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState('');

  const handleStyleSelect = (preset: typeof STYLE_PRESETS[0]) => {
    setActiveStyleId(preset.id);
    if (preset.id !== 'custom') {
      setStyle(preset.style);
    }
  };

  const handleGenerate = async () => {
    if (!idea.trim()) return;
    setIsGenerating(true);
    setError('');
    
    try {
      const plan = await generateFilmPlan(idea, {
        duration,
        aspectRatio,
        style,
        videoStyle,
        language,
        audience: 'Family and children',
      });
      applyFilmPlan(plan);
      
      // Auto run pipeline after applying
      setTimeout(() => {
        runPipeline();
      }, 500);

      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to generate film plan');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleLoginChatGPT = async () => {
    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      
      const res = await fetch('http://localhost:3000/api/chrome/launch-login', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ profile: 'chatgpt', url: 'https://chatgpt.com' })
      });
      
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || 'Không thể mở trình duyệt');
      }
      alert('Đã mở trình duyệt Chrome. Vui lòng đăng nhập ChatGPT rồi đóng trình duyệt lại.');
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl bg-[#1e212b] border border-gray-700 rounded-xl shadow-2xl p-6 relative max-h-[90vh] overflow-y-auto custom-scrollbar">
        <button 
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-white"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
             <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="flex items-center justify-between mb-2">
          <h2 className="text-2xl font-bold text-white">Auto Film Studio</h2>
          <button
            onClick={handleLoginChatGPT}
            className="text-xs flex items-center gap-1 bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-600 px-3 py-1.5 rounded-lg transition-colors mr-8"
            title="Mở trình duyệt để đăng nhập thủ công vào ChatGPT trước khi chạy"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
            </svg>
            Đăng nhập ChatGPT
          </button>
        </div>
        <p className="text-gray-400 mb-6 text-sm">
          Nhập ý tưởng của bạn, AI (ChatGPT) sẽ tự động viết kịch bản, quy hoạch nhân vật, bối cảnh và thiết kế toàn bộ luồng tạo video.
        </p>

        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Ý tưởng nội dung</label>
            <textarea
              className="w-full bg-[#252836] border border-gray-700 rounded-lg p-3 text-white placeholder-gray-500 focus:ring-2 focus:ring-indigo-500 min-h-[120px]"
              placeholder="VD: Một chú heo Bobo đi xe buýt cùng bạn bè, hát vui trên đường đến trường..."
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Thời lượng (giây)</label>
              <select 
                className="w-full bg-[#252836] border border-gray-700 rounded-lg p-2.5 text-white"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              >
                <option value="30">30 Giây</option>
                <option value="60">1 Phút</option>
                <option value="120">2 Phút</option>
                <option value="180">3 Phút</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Tỉ lệ khung hình</label>
              <select 
                className="w-full bg-[#252836] border border-gray-700 rounded-lg p-2.5 text-white"
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value)}
              >
                <option value="16:9">16:9 (YouTube)</option>
                <option value="9:16">9:16 (Shorts/TikTok)</option>
                <option value="1:1">1:1 (Square)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Ngôn ngữ</label>
              <select 
                className="w-full bg-[#252836] border border-gray-700 rounded-lg p-2.5 text-white"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="Vietnamese">Tiếng Việt</option>
                <option value="English">English</option>
                <option value="Japanese">Japanese</option>
                <option value="Korean">Korean</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Phong cách hình ảnh</label>
            <div className="flex flex-wrap gap-2 mb-3">
              {STYLE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => handleStyleSelect(preset)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
                    activeStyleId === preset.id
                      ? 'bg-indigo-600/80 text-white border-indigo-500'
                      : 'bg-[#252836] text-gray-400 border-gray-700 hover:bg-gray-700 hover:text-gray-200'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <textarea
              className="w-full bg-[#252836]/50 border border-gray-700 rounded-lg p-3 text-white placeholder-gray-500 focus:ring-2 focus:ring-indigo-500 min-h-[70px] text-sm"
              value={style}
              onChange={(e) => {
                setStyle(e.target.value);
                if (activeStyleId !== 'custom') setActiveStyleId('custom');
              }}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Phong cách chuyển động (Video Motion Style)</label>
            <textarea
              className="w-full bg-[#252836]/50 border border-indigo-500/30 rounded-lg p-3 text-white placeholder-gray-500 focus:ring-2 focus:ring-indigo-500 min-h-[60px] text-sm"
              value={videoStyle}
              onChange={(e) => setVideoStyle(e.target.value)}
            />
          </div>

          {error && (
            <div className="p-3 bg-red-900/50 border border-red-500/50 rounded-lg text-red-200 text-sm">
              {error}
            </div>
          )}

          <div className="pt-4 flex justify-end gap-3">
            <button
              onClick={onClose}
              className="px-5 py-2.5 rounded-lg text-sm font-medium text-gray-300 hover:bg-gray-800 transition-colors"
            >
              Hủy
            </button>
            <button
              onClick={handleGenerate}
              disabled={isGenerating || !idea.trim()}
              className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isGenerating ? (
                <>
                  <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Đang thiết kế kế hoạch...
                </>
              ) : (
                'Tạo Pipeline Tự Động'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
