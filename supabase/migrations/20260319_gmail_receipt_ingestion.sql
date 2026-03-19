create extension if not exists pgcrypto;

create table if not exists public.gmail_account_links (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  linked_by_profile_id uuid not null references public.profiles(id) on delete cascade,
  gmail_email text not null,
  google_subject_id text not null,
  refresh_token_encrypted text not null,
  access_token text,
  access_token_expires_at timestamptz,
  is_active boolean not null default true,
  initial_backfill_completed_at timestamptz,
  last_scan_started_at timestamptz,
  last_scan_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists gmail_account_links_team_email_active_idx
on public.gmail_account_links (team_id, lower(gmail_email))
where is_active = true;

create unique index if not exists gmail_account_links_subject_team_active_idx
on public.gmail_account_links (google_subject_id, team_id)
where is_active = true;

create index if not exists gmail_account_links_team_idx on public.gmail_account_links(team_id);
create index if not exists gmail_account_links_profile_idx on public.gmail_account_links(linked_by_profile_id);

create table if not exists public.email_receipt_ingestions (
  id uuid primary key default gen_random_uuid(),
  gmail_link_id uuid not null references public.gmail_account_links(id) on delete cascade,
  gmail_message_id text not null,
  gmail_thread_id text,
  team_id uuid not null references public.teams(id) on delete cascade,
  sender_email text,
  subject text,
  received_at timestamptz,
  artifact_source text not null check (artifact_source in ('attachment', 'email_pdf')),
  artifact_filename text not null,
  artifact_mime_type text not null,
  artifact_storage_path text not null,
  extraction jsonb not null,
  status text not null check (status in ('pending_approval', 'approved', 'rejected', 'duplicate', 'failed')),
  slack_dm_message_refs jsonb,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  error_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists email_receipt_ingestions_link_message_idx
on public.email_receipt_ingestions (gmail_link_id, gmail_message_id);

create index if not exists email_receipt_ingestions_team_idx on public.email_receipt_ingestions(team_id);
create index if not exists email_receipt_ingestions_status_idx on public.email_receipt_ingestions(status);

create table if not exists public.email_receipt_approvals (
  id uuid primary key default gen_random_uuid(),
  ingestion_id uuid not null references public.email_receipt_ingestions(id) on delete cascade,
  lead_profile_id uuid not null references public.profiles(id) on delete cascade,
  slack_user_id text not null,
  decision text not null check (decision in ('approved', 'rejected')),
  created_at timestamptz not null default now()
);

create index if not exists email_receipt_approvals_ingestion_idx on public.email_receipt_approvals(ingestion_id);
create unique index if not exists email_receipt_approvals_once_per_lead_idx
on public.email_receipt_approvals (ingestion_id, lead_profile_id);

drop trigger if exists gmail_account_links_set_updated_at on public.gmail_account_links;
create trigger gmail_account_links_set_updated_at
before update on public.gmail_account_links
for each row
execute function public.set_updated_at_timestamp();

drop trigger if exists email_receipt_ingestions_set_updated_at on public.email_receipt_ingestions;
create trigger email_receipt_ingestions_set_updated_at
before update on public.email_receipt_ingestions
for each row
execute function public.set_updated_at_timestamp();
