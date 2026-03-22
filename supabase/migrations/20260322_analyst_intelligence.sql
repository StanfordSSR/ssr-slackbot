create table if not exists public.analyst_runtime_config (
  config_key text primary key,
  config_value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.context_sources (
  id uuid primary key default gen_random_uuid(),
  linked_by_profile_id uuid references public.profiles(id) on delete set null,
  source_type text not null check (source_type in ('url', 'slack_file')),
  slack_file_id text,
  source_url text,
  title text not null,
  corpus text not null check (corpus in ('org', 'internal')),
  scope text not null check (scope in ('org', 'team')),
  team_id uuid references public.teams(id) on delete set null,
  tags text[] not null default '{}',
  is_canonical boolean not null default false,
  canonical_kind text,
  mime_type text,
  openai_file_id text,
  openai_vector_store_id text,
  content_text text,
  content_summary text,
  status text not null check (status in ('processing', 'ready', 'failed')),
  error_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists context_sources_status_idx on public.context_sources(status);
create index if not exists context_sources_corpus_idx on public.context_sources(corpus);
create index if not exists context_sources_team_idx on public.context_sources(team_id);
create index if not exists context_sources_tags_idx on public.context_sources using gin(tags);

create table if not exists public.question_sessions (
  id uuid primary key default gen_random_uuid(),
  slack_user_id text not null,
  profile_id uuid references public.profiles(id) on delete set null,
  channel_id text,
  thread_ts text,
  entrypoint text not null check (entrypoint in ('mention', 'slash_command')),
  prompt text not null,
  normalized_prompt text not null,
  route text,
  status text not null check (status in ('processing', 'completed', 'failed')),
  plan jsonb,
  final_answer text,
  confidence_label text,
  model_tier text,
  cost_tier text,
  estimated_cost_usd numeric(12,6),
  usage jsonb,
  cache_key text,
  error_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists question_sessions_profile_idx on public.question_sessions(profile_id);
create index if not exists question_sessions_cache_idx on public.question_sessions(cache_key);
create index if not exists question_sessions_status_idx on public.question_sessions(status);

create table if not exists public.question_tool_calls (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.question_sessions(id) on delete cascade,
  step_index integer not null default 0,
  tool_name text not null,
  input_json jsonb not null default '{}'::jsonb,
  output_json jsonb,
  duration_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists question_tool_calls_session_idx on public.question_tool_calls(session_id);

create table if not exists public.question_evidence (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.question_sessions(id) on delete cascade,
  source_kind text not null check (source_kind in ('org_profile', 'context_source', 'structured_tool', 'web')),
  source_ref text,
  title text not null,
  citation_text text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists question_evidence_session_idx on public.question_evidence(session_id);

create table if not exists public.answer_cache (
  id uuid primary key default gen_random_uuid(),
  cache_key text not null unique,
  answer_json jsonb not null,
  source_version_key text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

drop trigger if exists analyst_runtime_config_set_updated_at on public.analyst_runtime_config;
create trigger analyst_runtime_config_set_updated_at
before update on public.analyst_runtime_config
for each row
execute function public.set_updated_at_timestamp();

drop trigger if exists context_sources_set_updated_at on public.context_sources;
create trigger context_sources_set_updated_at
before update on public.context_sources
for each row
execute function public.set_updated_at_timestamp();

drop trigger if exists question_sessions_set_updated_at on public.question_sessions;
create trigger question_sessions_set_updated_at
before update on public.question_sessions
for each row
execute function public.set_updated_at_timestamp();
