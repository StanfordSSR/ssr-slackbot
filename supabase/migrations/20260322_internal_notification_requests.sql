create table if not exists public.internal_notification_requests (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  notification_type text not null,
  team_id uuid,
  team_name text,
  status text not null check (status in ('processing', 'completed', 'failed')),
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb,
  delivered_count integer not null default 0,
  failed_count integer not null default 0,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists internal_notification_requests_status_idx
on public.internal_notification_requests (status);

drop trigger if exists internal_notification_requests_set_updated_at on public.internal_notification_requests;
create trigger internal_notification_requests_set_updated_at
before update on public.internal_notification_requests
for each row
execute function public.set_updated_at_timestamp();
