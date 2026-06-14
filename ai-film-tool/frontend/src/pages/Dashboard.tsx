import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../hooks/useAuth';
import { useNavigate } from 'react-router-dom';
import { LogOut, Plus } from 'lucide-react';

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user) {
      fetchProjects();
    }
  }, [user]);

  const fetchProjects = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .order('created_at', { ascending: false });
      
    if (!error && data) {
      setProjects(data);
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between px-6 py-4 border-b border-border bg-card">
        <h1 className="text-xl font-bold">AI Film Studio</h1>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">{user?.email}</span>
          <button
            onClick={signOut}
            className="p-2 rounded-md hover:bg-secondary text-muted-foreground"
            title="Sign out"
          >
            <LogOut size={20} />
          </button>
        </div>
      </header>

      <main className="p-8 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-3xl font-semibold">Your Projects</h2>
          <button
            onClick={() => navigate('/projects/new')}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            <Plus size={20} />
            Create Project
          </button>
        </div>

        {loading ? (
          <div className="text-center text-muted-foreground">Loading projects...</div>
        ) : projects.length === 0 ? (
          <div className="text-center py-20 border-2 border-dashed border-border rounded-xl text-muted-foreground">
            <p>No projects found. Create your first film!</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects.map((project) => (
              <div 
                key={project.id} 
                className="p-6 bg-card rounded-xl border border-border shadow-sm hover:shadow-md transition-shadow cursor-pointer"
                onClick={() => navigate(`/projects/${project.id}`)}
              >
                <h3 className="text-xl font-semibold mb-2">{project.title}</h3>
                <p className="text-sm text-muted-foreground mb-4 capitalize">
                  {project.genre || 'Unspecified Genre'} • {project.duration_target}s
                </p>
                <div className="flex items-center justify-between">
                  <span className="px-3 py-1 text-xs rounded-full bg-secondary text-secondary-foreground">
                    {project.status}
                  </span>
                  <span className="text-sm font-medium">{project.progress}%</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
