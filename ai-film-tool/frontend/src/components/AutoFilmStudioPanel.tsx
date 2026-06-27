import { useState } from 'react';
import { useStore } from '../store/useStore';
import { supabase } from '../lib/supabase';

export function AutoFilmStudioPanel({ onClose }: { onClose: () => void }) {
  const generateFilmPlan = useStore((s) => s.generateFilmPlan);
  const applyFilmPlan = useStore((s) => s.applyFilmPlan);
  const runPipeline = useStore((s) => s.runPipeline);

  const [idea, setIdea] = useState('');
  const [duration, setDuration] = useState('60');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [style, setStyle] = useState('Original preschool 3D animation, rounded toy-like characters, bright colors');
  
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState('');

  const handleGenerate = async () => {
    if (!idea.trim()) return;
    setIsGenerating(true);
    setError('');
    
    try {
      const plan = await generateFilmPlan(idea, {
        duration,
        aspectRatio,
        style,
        language: 'Vietnamese',
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
      <div className="w-full max-w-2xl bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-6 relative">
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

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Ý tưởng nội dung</label>
            <textarea
              className="w-full bg-gray-800 border border-gray-700 rounded-lg p-3 text-white placeholder-gray-500 focus:ring-2 focus:ring-indigo-500 min-h-[120px]"
              placeholder="VD: Một chú heo Bobo đi xe buýt cùng bạn bè, hát vui trên đường đến trường..."
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Thời lượng (giây)</label>
              <select 
                className="w-full bg-gray-800 border border-gray-700 rounded-lg p-2.5 text-white"
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
                className="w-full bg-gray-800 border border-gray-700 rounded-lg p-2.5 text-white"
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value)}
              >
                <option value="16:9">16:9 (YouTube)</option>
                <option value="9:16">9:16 (Shorts/TikTok)</option>
                <option value="1:1">1:1 (Square)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Phong cách hình ảnh (Visual Style)</label>
            <input
              type="text"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg p-2.5 text-white placeholder-gray-500"
              value={style}
              onChange={(e) => setStyle(e.target.value)}
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
