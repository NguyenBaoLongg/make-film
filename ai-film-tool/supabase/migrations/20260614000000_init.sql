-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- 1. PROFILES
create table public.profiles (
  id uuid references auth.users(id) on delete cascade not null primary key,
  email text,
  full_name text,
  avatar_url text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);
alter table public.profiles enable row level security;
create policy "Users can view own profile." on public.profiles for select using (auth.uid() = id);
create policy "Users can update own profile." on public.profiles for update using (auth.uid() = id);

-- Trigger to create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'avatar_url');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Helper function for updated_at
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger profiles_updated_at before update on public.profiles for each row execute procedure handle_updated_at();

-- 2. PROJECTS
create table public.projects (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null,
  title text not null,
  idea_prompt text,
  genre text,
  duration_target integer,
  aspect_ratio text,
  visual_style text,
  language text,
  status text default 'draft',
  progress integer default 0,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);
alter table public.projects enable row level security;
create policy "Users can CRUD own projects." on public.projects for all using (auth.uid() = user_id);
create trigger projects_updated_at before update on public.projects for each row execute procedure handle_updated_at();

-- 3. ASSETS
create table public.assets (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null,
  project_id uuid references public.projects(id) on delete cascade not null,
  type text,
  bucket text,
  storage_path text,
  public_url text,
  signed_url text,
  mime_type text,
  size_bytes bigint,
  metadata_json jsonb,
  created_at timestamptz default now() not null
);
alter table public.assets enable row level security;
create policy "Users can CRUD own assets." on public.assets for all using (auth.uid() = user_id);

-- 4. CHARACTERS
create table public.characters (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null,
  project_id uuid references public.projects(id) on delete cascade not null,
  name text,
  role text,
  bible_json jsonb,
  reference_asset_id uuid references public.assets(id),
  approved boolean default false,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);
alter table public.characters enable row level security;
create policy "Users can CRUD own characters." on public.characters for all using (auth.uid() = user_id);
create trigger characters_updated_at before update on public.characters for each row execute procedure handle_updated_at();

-- 5. BACKGROUNDS
create table public.backgrounds (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null,
  project_id uuid references public.projects(id) on delete cascade not null,
  name text,
  bible_json jsonb,
  reference_asset_id uuid references public.assets(id),
  approved boolean default false,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);
alter table public.backgrounds enable row level security;
create policy "Users can CRUD own backgrounds." on public.backgrounds for all using (auth.uid() = user_id);
create trigger backgrounds_updated_at before update on public.backgrounds for each row execute procedure handle_updated_at();

-- 6. SCRIPTS
create table public.scripts (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null,
  project_id uuid references public.projects(id) on delete cascade not null,
  logline text,
  synopsis text,
  structure_json jsonb,
  script_json jsonb,
  approved boolean default false,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);
alter table public.scripts enable row level security;
create policy "Users can CRUD own scripts." on public.scripts for all using (auth.uid() = user_id);
create trigger scripts_updated_at before update on public.scripts for each row execute procedure handle_updated_at();

-- 7. SCENES
create table public.scenes (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null,
  project_id uuid references public.projects(id) on delete cascade not null,
  order_index integer,
  title text,
  description text,
  location text,
  mood text,
  duration_seconds integer,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);
alter table public.scenes enable row level security;
create policy "Users can CRUD own scenes." on public.scenes for all using (auth.uid() = user_id);
create trigger scenes_updated_at before update on public.scenes for each row execute procedure handle_updated_at();

-- 8. SHOTS
create table public.shots (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null,
  project_id uuid references public.projects(id) on delete cascade not null,
  scene_id uuid references public.scenes(id) on delete cascade not null,
  order_index integer,
  duration_seconds integer,
  camera_angle text,
  camera_movement text,
  action text,
  emotion text,
  dialogue text,
  voice_over text,
  characters_json jsonb,
  background_id uuid references public.backgrounds(id),
  start_frame_prompt text,
  end_frame_prompt text,
  veo_motion_prompt text,
  negative_prompt text,
  start_frame_asset_id uuid references public.assets(id),
  end_frame_asset_id uuid references public.assets(id),
  video_asset_id uuid references public.assets(id),
  status text default 'waiting_image',
  qc_score numeric,
  qc_notes text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);
alter table public.shots enable row level security;
create policy "Users can CRUD own shots." on public.shots for all using (auth.uid() = user_id);
create trigger shots_updated_at before update on public.shots for each row execute procedure handle_updated_at();

-- 9. GENERATION JOBS
create table public.generation_jobs (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null,
  project_id uuid references public.projects(id) on delete cascade not null,
  shot_id uuid references public.shots(id),
  type text,
  provider text,
  status text default 'pending',
  input_json jsonb,
  output_json jsonb,
  error_message text,
  retry_count integer default 0,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);
alter table public.generation_jobs enable row level security;
create policy "Users can CRUD own jobs." on public.generation_jobs for all using (auth.uid() = user_id);
create trigger jobs_updated_at before update on public.generation_jobs for each row execute procedure handle_updated_at();

-- 10. REVIEW LOGS
create table public.review_logs (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null,
  project_id uuid references public.projects(id) on delete cascade not null,
  shot_id uuid references public.shots(id) on delete cascade not null,
  reviewer_type text,
  status text,
  notes text,
  created_at timestamptz default now() not null
);
alter table public.review_logs enable row level security;
create policy "Users can CRUD own review logs." on public.review_logs for all using (auth.uid() = user_id);

-- 11. EXPORTS
create table public.exports (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete cascade not null,
  project_id uuid references public.projects(id) on delete cascade not null,
  asset_id uuid references public.assets(id),
  storage_path text,
  public_url text,
  duration_seconds integer,
  resolution text,
  status text,
  created_at timestamptz default now() not null
);
alter table public.exports enable row level security;
create policy "Users can CRUD own exports." on public.exports for all using (auth.uid() = user_id);

-- STORAGE BUCKET CONFIGURATION (Note: normally run via Admin UI or setup scripts, provided here for completeness)
-- INSERT INTO storage.buckets (id, name, public) VALUES ('film-assets', 'film-assets', true);
-- CREATE POLICY "Users can upload to their own project folder" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'film-assets' AND (storage.foldername(name))[2] = auth.uid()::text);
-- CREATE POLICY "Users can view their own project assets" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'film-assets' AND (storage.foldername(name))[2] = auth.uid()::text);
