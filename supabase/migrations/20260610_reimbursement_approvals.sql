create table if not exists public.reimbursement_pushes (
  reimbursement_id text primary key,
  team_id text not null,
  team_name text,
  requires_signature boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  title text,
  message text,
  cta_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists reimbursement_pushes_status_created_at_idx
on public.reimbursement_pushes (status, created_at);

drop trigger if exists reimbursement_pushes_set_updated_at on public.reimbursement_pushes;
create trigger reimbursement_pushes_set_updated_at
before update on public.reimbursement_pushes
for each row
execute function public.set_updated_at_timestamp();

create table if not exists public.reimbursement_messages (
  reimbursement_id text not null references public.reimbursement_pushes(reimbursement_id) on delete cascade,
  channel_id text not null,
  message_ts text not null,
  recipient_email text not null,
  created_at timestamptz not null default now(),
  primary key (reimbursement_id, message_ts)
);

create index if not exists reimbursement_messages_reimbursement_id_idx
on public.reimbursement_messages (reimbursement_id);
