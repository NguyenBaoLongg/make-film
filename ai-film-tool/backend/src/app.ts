import express from 'express';
import cors from 'cors';
import path from 'path';
import { requireAuth } from './middleware/authMiddleware';
import projectRoutes from './routes/projects';
import generateRoutes from './routes/generate';
import chromeRoutes from './routes/chrome';
import filmPlanRoutes from './routes/film-plan';
import extractFrameRoutes from './routes/extract-frame';

const app = express();

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use('/generated', express.static(path.join(process.cwd(), 'generated')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/projects', requireAuth, projectRoutes);
app.use('/api/generate/film-plan', requireAuth, filmPlanRoutes);
app.use('/api/generate/extract-frame', requireAuth, extractFrameRoutes);
app.use('/api/generate', requireAuth, generateRoutes);
app.use('/api/chrome', requireAuth, chromeRoutes);
// app.use('/api/assets', requireAuth, assetRoutes);

export default app;
