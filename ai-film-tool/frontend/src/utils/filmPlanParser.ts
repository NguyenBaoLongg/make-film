import type { Node, Edge } from '@xyflow/react';

export function parseFilmPlanToNodes(plan: any): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  let x = 0;
  let y = 0;

  const characters = plan.characters || [];
  const locations = plan.locations || [];
  const scenes = plan.scenes || [];

  if (characters.length === 0) {
    throw new Error("Lỗi: Kịch bản không có thông tin Nhân vật (Characters). Yêu cầu ChatGPT tạo lại!");
  }

  if (locations.length === 0) {
    throw new Error("Lỗi: Kịch bản không có thông tin Bối cảnh (Locations). Yêu cầu ChatGPT tạo lại!");
  }

  const refNodeIds = new Set<string>();

  // Trích xuất phong cách hình ảnh tổng thể để nhồi vào tất cả các prompt
  const filmBible = plan.film_bible || plan.project?.film_bible || {};
  const globalStyle = filmBible.visual_style || filmBible.style_lock || plan.project?.visual_style || '';
  const globalColor = Array.isArray(filmBible.color_palette)
    ? filmBible.color_palette.join(', ')
    : filmBible.color_palette || '';

  const defaultStyle = `
Stylized 3D toy-like preschool animation, rounded soft shapes, plastic/clay toy materials, bright pastel colors, soft daylight, clean composition, high-quality 3D render.
`;

  const styleSuffix = `
[MANDATORY VISUAL STYLE]
${globalStyle || defaultStyle}
Color palette: ${globalColor || 'bright pastel yellow, blue, red, pink, green'}

STRICT NEGATIVE STYLE RULES:
No photorealism. No real humans. No live-action. No realistic photography. No watercolor. No sketch. No flat illustration. No documentary style. No random people. No text. No logo. No watermark. No style shift.
`;

  function buildLocationPrompt(loc: any) {
    return `Create a MASTER LOCATION REFERENCE image.

Location ID: ${loc.id}
Location name: ${loc.name}

Base description:
${loc.reference_image_prompt || ''}

Continuity lock:
${loc.continuity_lock || ''}

Rules:
- This is a reusable background/location reference.
- No characters.
- No real humans.
- No random people.
- No text, logo, watermark.
- Keep composition clean and readable.
${styleSuffix}`;
  }

  function buildCharacterPrompt(char: any) {
    return `Create a MASTER CHARACTER REFERENCE image.

Character ID: ${char.id}
Character name: ${char.name}

Base description:
${char.reference_image_prompt || ''}

Identity lock:
${char.identity_lock || ''}

Rules:
- Full body character reference.
- Neutral pose.
- Clean simple background.
- Same face, outfit, colors, and body proportions must be reusable in every shot.
- No extra characters.
- No text, logo, watermark.
${styleSuffix}`;
  }

  function buildShotImagePrompt(shot: any, refs: any[]) {
    const refText = refs.map((ref) => `- ${ref.id}: ${ref.name}`).join('\n');

    return `Create a cinematic keyframe for this shot.

Attached visual references:
${refText}

Important:
- Match attached character references exactly.
- Match attached location references exactly.
- Do not rely on text IDs alone; use the attached images as visual source of truth.

Shot description:
${shot.image_prompt || ''}
${styleSuffix}`;
  }

  // 1. Create ImageGen nodes for Characters
  characters.forEach((char: any, i: number) => {
    const nodeId = `char_${char.id}`;
    refNodeIds.add(char.id);
    nodes.push({
      id: nodeId,
      type: 'imageGen',
      position: { x: x + i * 350, y: y },
      data: {
        prompt: buildCharacterPrompt(char),
        model: 'Imagen 3', // default
        ratio: '1:1', // Usually character refs are 1:1
        sceneIndex: -2, // Run first
        title: `Char: ${char.name || char.id}`,
      },
    });
  });

  // 2. Create ImageGen nodes for Locations
  locations.forEach((loc: any, i: number) => {
    const nodeId = `loc_${loc.id}`;
    refNodeIds.add(loc.id);
    nodes.push({
      id: nodeId,
      type: 'imageGen',
      position: { x: x + (characters.length + i) * 350, y: y },
      data: {
        prompt: buildLocationPrompt(loc),
        model: 'Imagen 3',
        ratio: plan.project?.aspect_ratio || '16:9',
        sceneIndex: -1, // Run after characters
        title: `Loc: ${loc.name || loc.id}`,
      },
    });
  });

  y += 400; // Move down for shots

  // 3. Create ImageGen and VideoGen for each shot
  let shotGlobalIndex = 1;
  const videoNodeIds: string[] = [];

  scenes.forEach((scene: any) => {
    const shots = scene.shots || [];
    shots.forEach((shot: any) => {
      const imageNodeId = `img_s${shotGlobalIndex}_${shot.id}`;
      const videoNodeId = `vid_s${shotGlobalIndex}_${shot.id}`;

      // Create ImageGen for shot
      nodes.push({
        id: imageNodeId,
        type: 'imageGen',
        position: { x: 0, y },
        data: {
          prompt: '', // Will be built after resolving refs
          model: 'Imagen 3',
          ratio: plan.project?.aspect_ratio || '16:9',
          sceneIndex: shotGlobalIndex,
          title: `Scene ${shotGlobalIndex} (Image)`,
        },
      });

      // Connect Master Refs to Shot Image & collect ref objects
      const refsList: any[] = [];
      const refIds = shot.reference_ids || [];
      refIds.forEach((refId: string) => {
        let sourceNodeId = '';
        const charRef = characters.find((c: any) => c.id === refId);
        const locRef = locations.find((l: any) => l.id === refId);

        if (charRef) {
          sourceNodeId = `char_${refId}`;
          refsList.push(charRef);
        } else if (locRef) {
          sourceNodeId = `loc_${refId}`;
          refsList.push(locRef);
        }

        if (sourceNodeId) {
          edges.push({
            id: `e_${sourceNodeId}_${imageNodeId}`,
            source: sourceNodeId,
            target: imageNodeId,
          });
        }
      });

      // Update shot prompt with resolved refs
      nodes[nodes.length - 1].data.prompt = buildShotImagePrompt(shot, refsList);

      // Create VideoGen for shot
      nodes.push({
        id: videoNodeId,
        type: 'videoGen',
        position: { x: 400, y },
        data: {
          motionPrompt: `${shot.video_prompt}\n\n[MANDATORY VIDEO STYLE]\nUse the provided image as the exact mandatory first frame.\nKeep the same stylized 3D toy-like preschool animation style.\nDo not redesign characters, outfit, face, colors, body proportions, lighting, or environment.\nNo photorealism. No real humans. No live-action. No style shift.\nNo background music. Keep ambient sound and foley/SFX for character actions.`,
          model: 'Veo 3.1 - Lite [Lower Priority]', // Default fast model
          duration: `${shot.duration_seconds || 4}s`,
          ratio: plan.project?.aspect_ratio || '16:9',
          mode: 'Frames to Video', // Key point from user's rules
          sceneIndex: shotGlobalIndex,
          title: `Scene ${shotGlobalIndex} (Video)`,
          narration: shot.voiceover_vi || shot.dialogue_vi || '',
        },
      });

      // Connect Image to Video
      edges.push({
        id: `e_${imageNodeId}_${videoNodeId}`,
        source: imageNodeId,
        target: videoNodeId,
        animated: true,
      });

      videoNodeIds.push(videoNodeId);
      y += 300;
      shotGlobalIndex += 1;
    });
  });

  // 4. Create ConcatNode at the end
  const concatId = 'concat_final';
  nodes.push({
    id: concatId,
    type: 'concat',
    position: { x: 800, y: Math.max(0, y - 300) / 2 }, // center vertically roughly
    data: {
      title: 'Final Render',
      autoSubtitles: true,
      ttsEnabled: true,
      ttsVoice: 'vi-VN-HoaiMyNeural',
      bgmUrl: '',
      topic: plan.project?.title || 'Auto Generated Film',
    },
  });

  // Connect all videos to concat
  videoNodeIds.forEach((vidId) => {
    edges.push({
      id: `e_${vidId}_${concatId}`,
      source: vidId,
      target: concatId,
    });
  });

  return { nodes, edges };
}
