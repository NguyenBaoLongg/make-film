import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

interface ChromeProfile {
  name: string;
  path: string;
  has_session: boolean;
  created_at: string;
}

interface ChromeManagerProps {
  onClose: () => void;
}

export default function ChromeManager({ onClose }: ChromeManagerProps) {
  const [profiles, setProfiles] = useState<ChromeProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [newProfileName, setNewProfileName] = useState('');
  const [launchingProfile, setLaunchingProfile] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const getAuthHeaders = async () => {
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };
  };

  const fetchProfiles = async () => {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('http://localhost:3000/api/chrome/profiles', { headers });
      if (res.ok) {
        const data = await res.json();
        setProfiles(data.profiles || []);
      }
    } catch (err) {
      console.error('Failed to fetch profiles:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProfiles();
  }, []);

  const handleCreateProfile = async () => {
    if (!newProfileName.trim()) return;
    
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('http://localhost:3000/api/chrome/create-profile', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: newProfileName.trim() })
      });
      
      if (res.ok) {
        setNewProfileName('');
        setMessage(`✅ Profile "${newProfileName}" đã được tạo!`);
        fetchProfiles();
      } else {
        const err = await res.json();
        setMessage(`❌ ${err.error}`);
      }
    } catch (err) {
      setMessage('❌ Không thể kết nối server');
    }
  };

  const handleLaunchLogin = async (profileName: string, url?: string) => {
    setLaunchingProfile(profileName);
    setMessage(`🌐 Đang mở Chrome cho "${profileName}"...`);
    
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('http://localhost:3000/api/chrome/launch-login', {
        method: 'POST',
        headers,
        body: JSON.stringify({ profile: profileName, url: url || 'https://accounts.google.com' })
      });
      
      if (res.ok) {
        setMessage(`✅ Chrome đã mở! Đăng nhập tài khoản Google rồi đóng Chrome để lưu session.`);
      } else {
        setMessage('❌ Không thể mở Chrome');
      }
    } catch (err) {
      setMessage('❌ Không thể kết nối server');
    } finally {
      setLaunchingProfile(null);
    }
  };

  const handleDeleteProfile = async (name: string) => {
    if (!confirm(`Xóa profile "${name}"? Session đăng nhập sẽ bị mất.`)) return;
    
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`http://localhost:3000/api/chrome/profiles/${name}`, {
        method: 'DELETE',
        headers
      });
      
      if (res.ok) {
        setMessage(`🗑️ Đã xóa profile "${name}"`);
        fetchProfiles();
      }
    } catch (err) {
      setMessage('❌ Lỗi xóa profile');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-[#0b101a] border border-[#1e293b] rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[#1e293b]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-500/20 rounded-lg flex items-center justify-center text-blue-400 text-xl">
              🌐
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Quản lý Chrome</h2>
              <p className="text-[10px] text-gray-400 uppercase tracking-wider">Browser Profile Manager</p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 bg-[#151b28] hover:bg-[#1e293b] rounded-full flex items-center justify-center text-gray-400">
            ✕
          </button>
        </div>

        {/* Message */}
        {message && (
          <div className="mx-5 mt-4 px-4 py-2 bg-[#111827] border border-[#1e293b] rounded-lg text-xs text-gray-300">
            {message}
          </div>
        )}

        {/* Create Profile */}
        <div className="p-5 border-b border-[#1e293b]">
          <label className="text-[10px] font-bold text-[#10b981] uppercase tracking-widest mb-2 block">Tạo Profile Mới</label>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="VD: google-main, veo3-account..."
              value={newProfileName}
              onChange={e => setNewProfileName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateProfile()}
              className="flex-1 bg-[#151b28] border border-[#1e293b] text-white text-sm px-3 py-2 rounded-lg outline-none focus:border-[#10b981]"
            />
            <button
              onClick={handleCreateProfile}
              disabled={!newProfileName.trim()}
              className="px-4 py-2 bg-[#10b981] text-black text-sm font-bold rounded-lg hover:bg-[#10b981]/90 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              + Tạo
            </button>
          </div>
        </div>

        {/* Profiles List */}
        <div className="p-5 max-h-64 overflow-y-auto space-y-3">
          <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2 block">
            Profiles ({profiles.length})
          </label>
          
          {loading ? (
            <div className="text-center text-gray-500 text-sm py-6">
              <span className="animate-spin inline-block mr-2">⏳</span>Đang tải...
            </div>
          ) : profiles.length === 0 ? (
            <div className="text-center text-gray-500 text-sm py-6">
              <div className="text-3xl mb-2 opacity-30">🌐</div>
              Chưa có profile nào. Tạo profile mới ở trên.
            </div>
          ) : (
            profiles.map((profile) => (
              <div
                key={profile.name}
                className="bg-[#111827] border border-[#1e293b] rounded-xl p-4 flex items-center justify-between group hover:border-blue-500/30 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-lg ${
                    profile.has_session 
                      ? 'bg-green-500/20 text-green-400' 
                      : 'bg-yellow-500/20 text-yellow-400'
                  }`}>
                    {profile.has_session ? '🔓' : '🔒'}
                  </div>
                  <div>
                    <div className="text-sm font-bold text-white">{profile.name}</div>
                    <div className="text-[10px] text-gray-500 flex items-center gap-2">
                      {profile.has_session ? (
                        <span className="text-green-400">● Đã đăng nhập</span>
                      ) : (
                        <span className="text-yellow-400">● Chưa đăng nhập</span>
                      )}
                    </div>
                  </div>
                </div>
                
                <div className="flex items-center gap-2">
                  {/* Nút mở Chrome để đăng nhập Google */}
                  <button
                    onClick={() => handleLaunchLogin(profile.name)}
                    disabled={launchingProfile === profile.name}
                    className="px-3 py-1.5 bg-blue-500/10 text-blue-400 border border-blue-500/20 text-[10px] font-bold rounded-lg hover:bg-blue-500/20 transition-colors disabled:opacity-50"
                  >
                    {launchingProfile === profile.name ? '⏳ Đang mở...' : '🌐 Login Google'}
                  </button>
                  
                  {/* Nút mở Chrome đến Veo 3 */}
                  <button
                    onClick={() => handleLaunchLogin(profile.name, 'https://labs.google/fx/tools/video-fx')}
                    disabled={launchingProfile === profile.name}
                    className="px-3 py-1.5 bg-purple-500/10 text-purple-400 border border-purple-500/20 text-[10px] font-bold rounded-lg hover:bg-purple-500/20 transition-colors disabled:opacity-50"
                    title="Mở Chrome đến Veo 3"
                  >
                    🎬 Veo 3
                  </button>
                  
                  {/* Xóa */}
                  <button
                    onClick={() => handleDeleteProfile(profile.name)}
                    className="w-7 h-7 bg-red-500/10 text-red-400 rounded-lg flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/20"
                    title="Xóa profile"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer info */}
        <div className="p-4 border-t border-[#1e293b] bg-[#080d16]">
          <p className="text-[10px] text-gray-500 leading-relaxed">
            💡 <strong>Hướng dẫn:</strong> Tạo profile → Bấm "Login Google" → Đăng nhập tài khoản Google trên Chrome → Đóng Chrome.
            Session sẽ được lưu. Khi chạy pipeline, hệ thống tự dùng lại session này.
          </p>
        </div>
      </div>
    </div>
  );
}
