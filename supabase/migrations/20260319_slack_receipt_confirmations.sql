create table if not exists public.slack_receipt_confirmations (
  id uuid primary key default gen_random_uuid(),
  slack_file_id text not null,
  team_id uuid not null references public.teams(id) on delete cascade,
  confirmed_by_profile_id uuid references public.profiles(id) on delete set null,
  purchase_log_id uuid references public.purchase_logs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists slack_receipt_confirmations_file_team_idx
on public.slack_receipt_confirmations (slack_file_id, team_id);

drop trigger if exists slack_receipt_confirmations_set_updated_at on public.slack_receipt_confirmations;
create trigger slack_receipt_confirmations_set_updated_at
before update on public.slack_receipt_confirmations
for each row
execute function public.set_updated_at_timestamp();
