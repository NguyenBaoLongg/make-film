import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export default function BackgroundStudio({ projectId }: { projectId: string }) {
  const [backgrounds, setBackgrounds] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchBackgrounds();
  }, [projectId]);

  const fetchBackgrounds = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('backgrounds')
      .select('*')
      .eq('project_id', projectId);

    if (!error && data) {
      setBackgrounds(data);
    }
    setLoading(false);
  };

  if (loading) return <div>Loading backgrounds...</div>;
  if (backgrounds.length === 0) return <div>No backgrounds found.</div>;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pb-12">
      {backgrounds.map(bg => (
        <div key={bg.id} className="bg-card p-6 rounded-xl border border-border flex flex-col">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h2 className="text-2xl font-bold">{bg.name}</h2>
              <span className="text-sm text-muted-foreground capitalize">{bg.bible_json.location_type}</span>
            </div>
            <div className="px-2 py-1 bg-secondary rounded text-xs">
              {bg.approved ? 'Approved' : 'Draft'}
            </div>
          </div>

          <div className="space-y-4 text-sm flex-1">
            <div className="grid grid-cols-2 gap-2">
              <span className="text-muted-foreground">Time of Day:</span>
              <span>{bg.bible_json.time_of_day}</span>
              
              <span className="text-muted-foreground">Lighting:</span>
              <span>{bg.bible_json.lighting}</span>
              
              <span className="text-muted-foreground">Weather:</span>
              <span>{bg.bible_json.weather}</span>
            </div>

            <div>
              <strong className="block mb-1">Main Elements:</strong>
              <div className="flex flex-wrap gap-2">
                {bg.bible_json.main_elements?.map((el: string, i: number) => (
                  <span key={i} className="px-2 py-1 bg-secondary rounded-md text-xs">{el}</span>
                ))}
              </div>
            </div>
            
            <div>
              <strong className="block mb-1">Must Keep:</strong>
              <ul className="list-disc list-inside text-muted-foreground">
                {bg.bible_json.must_keep?.map((k: string, i: number) => <li key={i}>{k}</li>)}
              </ul>
            </div>
          </div>

          <div className="mt-6 flex gap-2">
            <button className="flex-1 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90">
              Generate Variant
            </button>
            <button className="flex-1 py-2 border border-border rounded-md hover:bg-secondary">
              Approve
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
