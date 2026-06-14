import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import ScriptEditor from '../components/ScriptEditor';
import CharacterStudio from '../components/CharacterStudio';
import BackgroundStudio from '../components/BackgroundStudio';
import StoryboardBoard from '../components/StoryboardBoard';

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<any>(null);
  const [activeTab, setActiveTab] = useState('script');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchProject();
  }, [id]);

  const fetchProject = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', id)
      .single();

    if (!error && data) {
      setProject(data);
    }
    setLoading(false);
  };

  if (loading) return <div className="p-8 text-center">Loading project...</div>;
  if (!project) return <div className="p-8 text-center text-destructive">Project not found</div>;

  return (
    <div className="flex h-screen bg-background text-foreground flex-col overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate('/')} className="text-muted-foreground hover:text-foreground">
            ← Dashboard
          </button>
          <h1 className="text-xl font-bold">{project.title}</h1>
          <span className="px-3 py-1 text-xs rounded-full bg-secondary text-secondary-foreground">
            {project.status}
          </span>
        </div>
        
        {/* Tabs navigation */}
        <div className="flex bg-input rounded-lg p-1">
          {['script', 'characters', 'backgrounds', 'storyboard'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                activeTab === tab 
                  ? 'bg-background shadow-sm text-foreground' 
                  : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 overflow-auto p-6 bg-secondary/20">
        <div className="h-full">
          {activeTab === 'script' && <ScriptEditor projectId={project.id} />}
          {activeTab === 'characters' && <CharacterStudio projectId={project.id} />}
          {activeTab === 'backgrounds' && <BackgroundStudio projectId={project.id} />}
          {activeTab === 'storyboard' && <StoryboardBoard projectId={project.id} />}
        </div>
      </main>
    </div>
  );
}
