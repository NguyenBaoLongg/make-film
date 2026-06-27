# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI Film Tool — a web app that automates AI film generation by orchestrating browser bots (Playwright) against Google Flow and ChatGPT to produce AI images and videos, then assembles them into a final film with FFmpeg.

The repo lives under `ai-film-tool/` and is a monorepo with two independently-runnable packages:
- `ai-film-tool/backend/` — Express.js + TypeScript API server
- `ai-film-tool/frontend/` — React + Vite + TypeScript SPA

## Development Commands

### Backend (run from `ai-film-tool/backend/`)
```bash
pnpm dev          # Start with ts-node-dev (hot-reload)
```

### Frontend (run from `ai-film-tool/frontend/`)
```bash
pnpm dev          # Start Vite dev server (default port 5173)
pnpm build        # tsc + vite build
pnpm lint         # ESLint
```

### Python workers (invoked automatically by backend; also testable manually)
```bash
python python_workers/browser_automation.py --job tmp/jobs/<job>.json
python python_workers/video_editor.py --job tmp/jobs/<job>.json
python python_workers/chatgpt_planner.py --job tmp/jobs/<job>.json
```
Python dependencies: `playwright`, `ffmpeg-python`, `openai-whisper` (optional). Install Playwright browsers with `playwright install chromium`.

## Environment Variables

**Backend** (`ai-film-tool/backend/.env`):
| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Frontend-safe key (not used by backend directly) |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend admin key — bypasses RLS |
| `GOOGLE_FLOW_URL` | Entry URL for Google Flow automation |
| `PLAYWRIGHT_HEADLESS` | `"true"` for headless Chrome |
| `PYTHON_EXECUTABLE` | Override Python path (else auto-detected) |
| `PUBLIC_API_URL` | Base URL exposed to Python workers for asset URLs |
| `PORT` | HTTP port (default `3000`) |

**Frontend** (`ai-film-tool/frontend/.env`):
| Variable | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Backend base URL (`http://localhost:3000`) |
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key for frontend auth |

## Architecture

### Request Flow

```
Frontend (React) → Backend (Express) → Python worker (Playwright/FFmpeg) → Google Flow / ChatGPT
                                    ↓
                              backend/generated/  (images, videos, final film)
```

### Backend (`backend/src/`)

- `server.ts` — starts Express on configured port
- `app.ts` — wires middleware (CORS, JSON 100 MB limit, static `/generated`) and mounts routes
- `config/env.ts` — single config object loaded from `dotenv`
- `middleware/authMiddleware.ts` — validates Supabase JWT Bearer tokens; attaches `req.user`
- `supabase/supabaseAdmin.ts` — Supabase client with **service role key** (never expose to frontend)

**Routes** (all under `/api/`, all protected by `requireAuth` except `/health`):
| Route | File | Purpose |
|---|---|---|
| `POST /api/generate/flow-image` | `routes/generate.ts` | Generate one AI image via Google Flow |
| `POST /api/generate/flow-video` | `routes/generate.ts` | Generate one AI video from source image |
| `POST /api/generate/flow-scene` | `routes/generate.ts` | Generate image + video in one run |
| `POST /api/generate/flow-scene/stream` | `routes/generate.ts` | Same as above but SSE stream of progress events |
| `POST /api/generate/concat-videos` | `routes/generate.ts` | Concatenate scenes into final film (calls `video_editor.py`) |
| `GET /api/generate/logs/:runId` | `routes/generate.ts` | Fetch worker log for a run |
| `POST /api/generate/film-plan` | `routes/film-plan.ts` | Generate film plan via ChatGPT automation |
| `GET/POST /api/projects` | `routes/projects.ts` | CRUD projects in Supabase |
| `GET /api/chrome/profiles` | `routes/chrome.ts` | List Chrome profiles |
| `POST /api/chrome/launch-login` | `routes/chrome.ts` | Open Chrome for manual Google login |

**Worker invocation pattern** (`routes/generate.ts`):
1. Write a JSON job file to `tmp/jobs/<uuid>.json`
2. Spawn `browser_automation.py --job <path>` via `child_process.spawn`
3. Parse `FLOW_EVENT {...}` lines from stderr as structured progress events
4. On process exit, parse the last JSON object from stdout as the result
5. If exit code ≠ 0, try the next Python candidate (`python`, `py -3`, venv)

### Python Workers (`backend/python_workers/`)

**`browser_automation.py`** — the core bot:
- Uses Playwright `sync_playwright` with a persistent Chrome profile (`chrome_profiles/<profile>/`)
- `run_job()` dispatches to `process_single_media_job()` or `process_scene_job()` based on `job["type"]` (`image`, `video`, `scene`)
- A `scene` job generates an image first, emits `FLOW_EVENT image_done`, then generates video from that image, emits `FLOW_EVENT video_done`
- Media download cascade (4 attempts in order): Playwright API request → UI download button → urllib with cookies → fetch blob base64
- Debug screenshots saved to `generated/_debug/<timestamp>_<type>_<scene>/`
- Emits `FLOW_EVENT` on stderr with the format: `FLOW_EVENT {"event": "...", "data": {...}}`

**`video_editor.py`** — FFmpeg-based post-processing:
- Concatenates scene MP4s, normalises resolution/framerate
- Optionally: Whisper auto-subtitles, BGM mixing (volume 30%), "TẬP PHIM" title overlay (first 5s)
- Uses `ffmpeg-python` library; Whisper models stored in `python_workers/whisper_models/`

**`chatgpt_planner.py`** — ChatGPT automation:
- Opens ChatGPT with a persistent Chrome profile (`chrome_profiles/chatgpt/`)
- Sends multi-step prompts to generate a structured film plan (JSON)

### Frontend (`frontend/src/`)

**Pages**: `Login` → `Dashboard` → `CreateProject` / `ProjectDetail` / `Workspace`

**Workspace** is the main editor — a React Flow (XYFlow) canvas with drag-and-drop nodes:
| Node type | Component | Role |
|---|---|---|
| `mediaSource` | `MediaSourceNode` | Reference image input |
| `imageGen` | `ImageGenNode` | Triggers `POST /api/generate/flow-image` |
| `videoGen` | `VideoGenNode` | Triggers `POST /api/generate/flow-video` |
| `concat` | `ConcatNode` | Triggers `POST /api/generate/concat-videos` |

**State** — Zustand store at `store/useStore.ts`:
- Holds nodes, edges, pipeline progress, logs
- `runPipeline()` walks the graph: image nodes first → connected video nodes → concat nodes
- `generateFilmPlan()` calls `POST /api/generate/film-plan` then `applyFilmPlan()` converts the plan into nodes via `utils/filmPlanParser.ts`
- Supabase is used to persist the React Flow graph (`loadFlowFromSupabase`)

**Auth** — `hooks/useAuth.ts` wraps Supabase auth; `PrivateRoute` guards all pages except `/login`.

### Database (Supabase)

Tables: `projects`, `scripts`, `characters`, `backgrounds`, `scenes`, `shots`. The backend uses the **service role key** to write to all tables without RLS restrictions.

### Generated Files

`backend/generated/` — all output files (images, videos, final film). Served statically at `/generated/`. Intermediate scene videos are deleted after successful concat.

### Chrome Profiles

`backend/chrome_profiles/<profile-name>/` — persistent Chromium user data directories. The `default` profile is used for Google Flow; `chatgpt` for ChatGPT. Users must manually log in once via `POST /api/chrome/launch-login` before automation works.

## Key Conventions

- Worker stdout must contain a valid JSON object as the last output; everything else is logged to stderr.
- `FLOW_EVENT` lines on stderr carry structured SSE events, parsed by the Express layer.
- Node IDs in the React Flow graph are `<type>-<timestamp>` (e.g. `imageGen-1782410000000`).
- The `sceneIndex` node data field drives processing order in `runPipeline`.
- `aiService.ts` (`services/aiService.ts`) is currently a mock — it returns hardcoded data and does not call any AI API.
