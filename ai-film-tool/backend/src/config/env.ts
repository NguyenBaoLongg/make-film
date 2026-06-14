import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: process.env.PORT || 3000,
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  supabaseStorageBucket: process.env.SUPABASE_STORAGE_BUCKET || 'film-assets',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  aiProvider: process.env.AI_PROVIDER || 'mock',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  useMockImageWorker: process.env.USE_MOCK_IMAGE_WORKER === 'true',
  useMockVideoWorker: process.env.USE_MOCK_VIDEO_WORKER === 'true',
  playwrightHeadless: process.env.PLAYWRIGHT_HEADLESS === 'true',
  tempDir: process.env.TEMP_DIR || './tmp',
  publicAppUrl: process.env.PUBLIC_APP_URL || 'http://localhost:5173',
  publicApiUrl: process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 3000}`,
  pythonExecutable: process.env.PYTHON_EXECUTABLE || '',
  googleFlowUrl: process.env.GOOGLE_FLOW_URL || 'https://flow.google/',
};
