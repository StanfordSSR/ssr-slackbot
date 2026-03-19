create extension if not exists pgcrypto;

create table if not exists public.slack_user_links (
  id uuid primary key default gen_random_uuid(),
  slack_user_id text not null unique,
  user_id uuid references public.profiles(id) on delete set null,
  default_team_id uuid references public.teams(id) on delete set null,
  slack_display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists slack_user_links_user_id_idx on public.slack_user_links(user_id);
create index if not exists slack_user_links_default_team_id_idx on public.slack_user_links(default_team_id);

create or replace function public.set_updated_at_timestamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists slack_user_links_set_updated_at on public.slack_user_links;
create trigger slack_user_links_set_updated_at
before update on public.slack_user_links
for each row
execute function public.set_updated_at_timestamp();
