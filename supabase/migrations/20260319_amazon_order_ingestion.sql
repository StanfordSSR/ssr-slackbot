alter table public.profiles
add column if not exists is_admin boolean not null default false;

create table if not exists public.amazon_account_links (
  id uuid primary key default gen_random_uuid(),
  linked_by_profile_id uuid not null references public.profiles(id) on delete cascade,
  gmail_email text not null,
  slack_channel_id text not null,
  google_subject_id text not null,
  refresh_token_encrypted text not null,
  access_token text,
  access_token_expires_at timestamptz,
  is_active boolean not null default true,
  last_scan_started_at timestamptz,
  last_scan_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists amazon_account_links_single_active_idx
on public.amazon_account_links ((is_active))
where is_active = true;

create table if not exists public.amazon_order_ingestions (
  id uuid primary key default gen_random_uuid(),
  amazon_link_id uuid not null references public.amazon_account_links(id) on delete cascade,
  gmail_message_id text not null,
  gmail_thread_id text,
  sender_email text,
  subject text,
  received_at timestamptz,
  item_name text,
  amount_total numeric,
  currency text,
  purchase_date date,
  slack_channel_id text,
  slack_message_ts text,
  claimed_team_id uuid references public.teams(id) on delete set null,
  claimed_by_profile_id uuid references public.profiles(id) on delete set null,
  claimed_at timestamptz,
  purchase_log_id uuid,
  status text not null check (status in ('pending_claim', 'claimed', 'failed')),
  error_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists amazon_order_ingestions_message_idx
on public.amazon_order_ingestions (amazon_link_id, gmail_message_id);

create index if not exists amazon_order_ingestions_status_idx
on public.amazon_order_ingestions(status);

drop trigger if exists amazon_account_links_set_updated_at on public.amazon_account_links;
create trigger amazon_account_links_set_updated_at
before update on public.amazon_account_links
for each row
execute function public.set_updated_at_timestamp();

drop trigger if exists amazon_order_ingestions_set_updated_at on public.amazon_order_ingestions;
create trigger amazon_order_ingestions_set_updated_at
before update on public.amazon_order_ingestions
for each row
execute function public.set_updated_at_timestamp();
