import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export default function CharacterStudio({ projectId }: { projectId: string }) {
  const [characters, setCharacters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchCharacters();
  }, [projectId]);

  const fetchCharacters = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('characters')
      .select('*')
      .eq('project_id', projectId);

    if (!error && data) {
      setCharacters(data);
    }
    setLoading(false);
  };

  if (loading) return <div>Loading characters...</div>;
  if (characters.length === 0) return <div>No characters found.</div>;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pb-12">
      {characters.map(char => (
        <div key={char.id} className="bg-card p-6 rounded-xl border border-border flex flex-col">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h2 className="text-2xl font-bold">{char.name}</h2>
              <span className="text-sm text-muted-foreground capitalize">{char.role}</span>
            </div>
            <div className="px-2 py-1 bg-secondary rounded text-xs">
              {char.approved ? 'Approved' : 'Draft'}
            </div>
          </div>

          <div className="space-y-4 text-sm flex-1">
            <div className="grid grid-cols-2 gap-2">
              <span className="text-muted-foreground">Age:</span>
              <span>{char.bible_json.age}</span>
              
              <span className="text-muted-foreground">Species:</span>
              <span>{char.bible_json.species}</span>
              
              <span className="text-muted-foreground">Body Shape:</span>
              <span>{char.bible_json.body_shape}</span>
              
              <span className="text-muted-foreground">Outfit:</span>
              <span>{char.bible_json.outfit}</span>
            </div>

            <div>
              <strong className="block mb-1">Must Keep:</strong>
              <ul className="list-disc list-inside text-muted-foreground">
                {char.bible_json.must_keep?.map((k: string, i: number) => <li key={i}>{k}</li>)}
              </ul>
            </div>
            
            <div>
              <strong className="block mb-1">Do Not Change:</strong>
              <ul className="list-disc list-inside text-muted-foreground">
                {char.bible_json.do_not_change?.map((k: string, i: number) => <li key={i}>{k}</li>)}
              </ul>
            </div>
          </div>

          <div className="mt-6 flex gap-2">
            <button className="flex-1 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90">
              Generate Sheet
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
