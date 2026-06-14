export interface FilmPlanInput {
  title: string;
  idea_prompt: string;
  duration_target: number;
  aspect_ratio: string;
  visual_style: string;
}

export const aiService = {
  generateFilmPlan: async (input: FilmPlanInput) => {
    console.log(`Generating mock film plan for: ${input.title}`);
    
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 2000));

    return {
      film_title: input.title,
      logline: `A mock logline generated for ${input.idea_prompt}.`,
      synopsis: `A detailed synopsis about ${input.title}. It explores the themes of adventure and comedy within a ${input.visual_style} setting.`,
      genre: "Adventure / Comedy",
      target_duration_seconds: input.duration_target,
      aspect_ratio: input.aspect_ratio,
      visual_style: input.visual_style,
      characters: [
        {
          name: "Bobo",
          role: "main_character",
          age: "8 tuổi",
          species: "heo con hoạt hình",
          body_shape: "tròn trịa, thấp, đáng yêu",
          face: "mắt to, má hồng, mũi nhỏ",
          outfit: "áo yếm xanh, khăn đỏ",
          color_palette: ["hồng nhạt", "xanh da trời", "đỏ"],
          personality: "tò mò, hiếu động, biết hối lỗi",
          must_keep: ["giữ nguyên khuôn mặt", "giữ phong cách hoạt hình 3D"],
          do_not_change: ["không đổi mặt", "không đổi quần áo"]
        }
      ],
      backgrounds: [
        {
          name: "Sân nhà bác Dê",
          location_type: "sân nhà nông thôn hoạt hình",
          time_of_day: "buổi sáng",
          lighting: "ánh sáng mềm, ấm",
          weather: "trời trong",
          main_elements: ["hàng rào gỗ", "chậu hoa"],
          color_palette: ["xanh lá", "nâu gỗ", "vàng nắng"],
          must_keep: ["giữ đúng bố cục sân"]
        }
      ],
      scenes: [
        {
          order_index: 1,
          title: "Bobo lạc đường",
          description: "Bobo đi lang thang vào khu rừng và phát hiện ra sân nhà bác Dê.",
          location: "Sân nhà bác Dê",
          mood: "tò mò, vui vẻ",
          duration_seconds: 30
        }
      ]
    };
  }
};
