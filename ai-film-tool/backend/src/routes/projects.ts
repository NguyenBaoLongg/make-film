import { Router } from 'express';
import { supabaseAdmin } from '../supabase/supabaseAdmin';
import { aiService } from '../services/aiService';

const router = Router();

router.get('/', async (req, res) => {
  const userId = (req as any).user.id;
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/', async (req, res) => {
  const userId = (req as any).user.id;
  const { title, idea_prompt, duration_target, aspect_ratio, visual_style } = req.body;

  const { data, error } = await supabaseAdmin
    .from('projects')
    .insert([
      {
        user_id: userId,
        title,
        idea_prompt,
        duration_target,
        aspect_ratio,
        visual_style,
        status: 'draft',
        progress: 0,
      }
    ])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/:id/generate-film-plan', async (req, res) => {
  const userId = (req as any).user.id;
  const projectId = req.params.id;

  try {
    // 1. Fetch project details
    const { data: project, error: fetchError } = await supabaseAdmin
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !project) return res.status(404).json({ error: 'Project not found' });

    // 2. Generate plan using mock AI
    const plan = await aiService.generateFilmPlan({
      title: project.title,
      idea_prompt: project.idea_prompt,
      duration_target: project.duration_target,
      aspect_ratio: project.aspect_ratio,
      visual_style: project.visual_style
    });

    // 3. Save Script to DB
    const { error: scriptError } = await supabaseAdmin
      .from('scripts')
      .insert([{
        user_id: userId,
        project_id: projectId,
        logline: plan.logline,
        synopsis: plan.synopsis,
        script_json: plan,
      }]);

    if (scriptError) throw scriptError;

    // 4. Insert Characters
    if (plan.characters && plan.characters.length > 0) {
      const charsToInsert = plan.characters.map((c: any) => ({
        user_id: userId,
        project_id: projectId,
        name: c.name,
        role: c.role,
        bible_json: c
      }));
      await supabaseAdmin.from('characters').insert(charsToInsert);
    }

    // 5. Insert Backgrounds
    if (plan.backgrounds && plan.backgrounds.length > 0) {
      const bgsToInsert = plan.backgrounds.map((b: any) => ({
        user_id: userId,
        project_id: projectId,
        name: b.name,
        bible_json: b
      }));
      await supabaseAdmin.from('backgrounds').insert(bgsToInsert);
    }

    // 6. Insert Scenes and Shots
    if (plan.scenes && plan.scenes.length > 0) {
      for (const s of plan.scenes) {
        const { data: sceneData, error: sceneError } = await supabaseAdmin
          .from('scenes')
          .insert([{
            user_id: userId,
            project_id: projectId,
            order_index: s.order_index,
            title: s.title,
            description: s.description,
            location: s.location,
            mood: s.mood,
            duration_seconds: s.duration_seconds
          }])
          .select()
          .single();

        if (!sceneError && sceneData) {
          // Create a mock shot for each scene
          await supabaseAdmin.from('shots').insert([{
            user_id: userId,
            project_id: projectId,
            scene_id: sceneData.id,
            order_index: 1,
            duration_seconds: s.duration_seconds,
            camera_angle: "wide shot",
            camera_movement: "slow pan",
            action: s.description,
            emotion: s.mood,
            dialogue: "",
            status: "waiting_image"
          }]);
        }
      }
    }

    // 7. Update project status
    await supabaseAdmin
      .from('projects')
      .update({ status: 'storyboard_ready', progress: 30 })
      .eq('id', projectId);

    res.json({ message: 'Film plan generated successfully', plan });
  } catch (error: any) {
    console.error('Generation Error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
