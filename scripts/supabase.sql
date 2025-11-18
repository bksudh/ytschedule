-- Supabase schema for YouTube Scheduler integration
-- Create tables: videos, playlists, stream_events

-- NOTE: Run this in Supabase SQL editor (Project -> SQL) or via CLI.

-- ===================
-- Table: videos
-- ===================
create table if not exists public.videos (
  id text primary key,
  title text,
  filename text,
  filepath text,
  filesize bigint,
  duration integer,
  rtmp_url text,
  stream_key text,
  schedule_time timestamptz,
  stop_time timestamptz,
  playlist_id text,
  status text,
  progress integer,
  error_message text,
  uploaded_at timestamptz,
  stream_started_at timestamptz,
  stream_ended_at timestamptz,
  used_rtmp_url text,
  used_stream_key text,
  last_output_url text,
  created_at timestamptz,
  updated_at timestamptz
);

create index if not exists videos_status_idx on public.videos (status);
create index if not exists videos_schedule_time_idx on public.videos (schedule_time);
create index if not exists videos_playlist_id_idx on public.videos (playlist_id);

-- ===================
-- Table: playlists
-- ===================
create table if not exists public.playlists (
  id text primary key,
  name text,
  description text,
  schedule_time timestamptz,
  status text,
  current_index integer,
  rtmp_url text,
  stream_key text,
  stream_started_at timestamptz,
  stream_ended_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
);

create index if not exists playlists_status_idx on public.playlists (status);
create index if not exists playlists_schedule_time_idx on public.playlists (schedule_time);

-- ===================
-- Table: stream_events
-- ===================
create table if not exists public.stream_events (
  id bigserial primary key,
  video_id text not null,
  type text not null,
  created_at timestamptz not null default now(),
  progress integer,
  output_url text,
  message text
);

create index if not exists stream_events_video_id_idx on public.stream_events (video_id);

-- ===================
-- Optional RLS (disabled by default for server-side writes)
-- ===================
-- If you plan to expose these tables to the frontend, enable RLS and
-- add policies. For pure server-side writes (service_role), you can
-- leave RLS off or write permissive policies for service_role only.