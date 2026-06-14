import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export default function ScriptEditor({ projectId }: { projectId: string }) {
  const [script, setScript] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchScript();
  }, [projectId]);

  const fetchScript = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('scripts')
      .select('*')
      .eq('project_id', projectId)
      .single();

    if (!error && data) {
      setScript(data);
    }
    setLoading(false);
  };

  if (loading) return <div>Loading script...</div>;
  if (!script) return <div>No script found.</div>;

  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-12">
      <div className="bg-card p-6 rounded-xl border border-border">
        <h2 className="text-xl font-bold mb-4">Logline</h2>
        <p className="text-muted-foreground">{script.logline}</p>
      </div>

      <div className="bg-card p-6 rounded-xl border border-border">
        <h2 className="text-xl font-bold mb-4">Synopsis</h2>
        <p className="text-muted-foreground whitespace-pre-wrap">{script.synopsis}</p>
      </div>

      <div className="bg-card p-6 rounded-xl border border-border">
        <h2 className="text-xl font-bold mb-4">Raw Film Plan JSON (MVP)</h2>
        <pre className="bg-input p-4 rounded-md overflow-x-auto text-xs text-muted-foreground">
          {JSON.stringify(script.script_json, null, 2)}
        </pre>
      </div>

      <div className="flex gap-4">
        <button className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90">
          Approve Script
        </button>
        <button className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/90">
          Regenerate Script
        </button>
      </div>
    </div>
  );
}
