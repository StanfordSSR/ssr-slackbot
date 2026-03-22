alter table public.profiles
add column if not exists slack_user_id text;

create unique index if not exists profiles_slack_user_id_idx
on public.profiles (slack_user_id)
where slack_user_id is not null;
