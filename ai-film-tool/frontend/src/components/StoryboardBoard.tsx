import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export default function StoryboardBoard({ projectId }: { projectId: string }) {
  const [scenes, setScenes] = useState<any[]>([]);
  const [shots, setShots] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStoryboard();
  }, [projectId]);

  const fetchStoryboard = async () => {
    setLoading(true);
    // Fetch Scenes
    const { data: scenesData } = await supabase
      .from('scenes')
      .select('*')
      .eq('project_id', projectId)
      .order('order_index', { ascending: true });

    // Fetch Shots
    const { data: shotsData } = await supabase
      .from('shots')
      .select('*')
      .eq('project_id', projectId)
      .order('order_index', { ascending: true });

    if (scenesData) setScenes(scenesData);
    if (shotsData) setShots(shotsData);
    
    setLoading(false);
  };

  if (loading) return <div>Loading storyboard...</div>;
  if (scenes.length === 0) return <div>No scenes found. Generate a film plan first.</div>;

  return (
    <div className="space-y-12 pb-12">
      {scenes.map(scene => {
        const sceneShots = shots.filter(s => s.scene_id === scene.id);

        return (
          <div key={scene.id} className="space-y-6">
            <div className="bg-primary/5 border border-primary/20 p-4 rounded-lg">
              <h2 className="text-xl font-bold mb-2">Scene {scene.order_index}: {scene.title}</h2>
              <p className="text-sm text-muted-foreground mb-2">{scene.description}</p>
              <div className="flex gap-4 text-xs font-medium">
                <span className="px-2 py-1 bg-background rounded border border-border">📍 {scene.location}</span>
                <span className="px-2 py-1 bg-background rounded border border-border">🎭 {scene.mood}</span>
                <span className="px-2 py-1 bg-background rounded border border-border">⏱️ {scene.duration_seconds}s</span>
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 pl-4 md:pl-8 border-l-2 border-border">
              {sceneShots.map((shot, idx) => (
                <div key={shot.id} className="bg-card rounded-xl border border-border overflow-hidden shadow-sm flex flex-col">
                  {/* Top Bar */}
                  <div className="flex items-center justify-between px-4 py-2 bg-secondary/50 border-b border-border text-sm font-medium">
                    <span>Shot {idx + 1}</span>
                    <span className="text-xs px-2 py-1 bg-background rounded">{shot.status}</span>
                  </div>

                  {/* Content */}
                  <div className="p-4 space-y-4 flex-1">
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-muted-foreground block text-xs">Camera Angle</span>
                        {shot.camera_angle}
                      </div>
                      <div>
                        <span className="text-muted-foreground block text-xs">Movement</span>
                        {shot.camera_movement}
                      </div>
                    </div>

                    <div>
                      <span className="text-muted-foreground block text-xs mb-1">Action</span>
                      <p className="text-sm">{shot.action}</p>
                    </div>

                    {shot.dialogue && (
                      <div className="bg-muted p-3 rounded-md text-sm italic border-l-4 border-primary">
                        "{shot.dialogue}"
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="p-4 border-t border-border grid grid-cols-3 gap-2">
                    <button className="py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded hover:bg-primary/90">
                      Gen Image
                    </button>
                    <button className="py-1.5 text-xs font-medium bg-secondary text-secondary-foreground rounded hover:bg-secondary/80">
                      Gen Video
                    </button>
                    <button className="py-1.5 text-xs font-medium border border-border rounded hover:bg-background">
                      Approve
                    </button>
                  </div>
                </div>
              ))}
              
              <div className="flex items-center justify-center p-6 border-2 border-dashed border-border rounded-xl text-muted-foreground cursor-pointer hover:bg-secondary/50 transition-colors">
                + Add Shot
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
