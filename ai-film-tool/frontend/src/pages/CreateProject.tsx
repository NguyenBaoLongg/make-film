import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';

export default function CreateProject() {
  const navigate = useNavigate();
  const { user } = useAuth();
  
  const [title, setTitle] = useState('');
  const [ideaPrompt, setIdeaPrompt] = useState('');
  const [duration, setDuration] = useState(60);
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [visualStyle, setVisualStyle] = useState('cinematic');
  const [language, setLanguage] = useState('Vietnamese');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setLoading(true);

    try {
      // 1. Create project
      const { data: project, error: projectError } = await supabase
        .from('projects')
        .insert([{
          user_id: user.id,
          title,
          idea_prompt: ideaPrompt,
          duration_target: duration,
          aspect_ratio: aspectRatio,
          visual_style: visualStyle,
          language,
          status: 'draft',
          progress: 0
        }])
        .select()
        .single();

      if (projectError) throw projectError;

      // 2. Trigger AI Generation (Mock API call)
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      
      const response = await fetch(`http://localhost:3000/api/projects/${project.id}/generate-film-plan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) throw new Error('Failed to generate film plan');

      // Navigate to project detail
      navigate(`/projects/${project.id}`);
    } catch (error) {
      console.error(error);
      alert('Error creating project');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground p-8 max-w-3xl mx-auto">
      <div className="flex items-center gap-4 mb-8">
        <button onClick={() => navigate('/')} className="text-muted-foreground hover:text-foreground">
          ← Back
        </button>
        <h1 className="text-3xl font-bold">Create New Film</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6 bg-card p-6 rounded-xl border border-border shadow-sm">
        <div>
          <label className="block text-sm font-medium mb-2">Film Title</label>
          <input 
            type="text" 
            value={title}
            onChange={e => setTitle(e.target.value)}
            className="w-full p-3 rounded-md bg-input border border-border focus:ring-2 focus:ring-primary outline-none"
            placeholder="e.g. The Lost Piglet"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Idea / Prompt</label>
          <textarea 
            value={ideaPrompt}
            onChange={e => setIdeaPrompt(e.target.value)}
            className="w-full p-3 rounded-md bg-input border border-border focus:ring-2 focus:ring-primary outline-none h-32 resize-none"
            placeholder="Describe your film idea in a few sentences..."
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium mb-2">Duration (seconds)</label>
            <input 
              type="number" 
              value={duration}
              onChange={e => setDuration(Number(e.target.value))}
              className="w-full p-3 rounded-md bg-input border border-border focus:ring-2 focus:ring-primary outline-none"
              min="10"
              max="300"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">Aspect Ratio</label>
            <select 
              value={aspectRatio}
              onChange={e => setAspectRatio(e.target.value)}
              className="w-full p-3 rounded-md bg-input border border-border focus:ring-2 focus:ring-primary outline-none"
            >
              <option value="16:9">16:9 (Landscape)</option>
              <option value="9:16">9:16 (Vertical)</option>
              <option value="1:1">1:1 (Square)</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium mb-2">Visual Style</label>
            <select 
              value={visualStyle}
              onChange={e => setVisualStyle(e.target.value)}
              className="w-full p-3 rounded-md bg-input border border-border focus:ring-2 focus:ring-primary outline-none"
            >
              <option value="cinematic">Cinematic</option>
              <option value="3d_animation">3D Animation / Pixar</option>
              <option value="anime">Anime</option>
              <option value="realistic">Realistic</option>
              <option value="fantasy">Fantasy</option>
              <option value="sci-fi">Sci-Fi</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-2">Language</label>
            <input 
              type="text" 
              value={language}
              onChange={e => setLanguage(e.target.value)}
              className="w-full p-3 rounded-md bg-input border border-border focus:ring-2 focus:ring-primary outline-none"
            />
          </div>
        </div>

        <button 
          type="submit" 
          disabled={loading}
          className="w-full py-3 bg-primary text-primary-foreground rounded-md font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {loading ? 'Generating Film Plan...' : 'Generate Film Plan'}
        </button>
      </form>
    </div>
  );
}
