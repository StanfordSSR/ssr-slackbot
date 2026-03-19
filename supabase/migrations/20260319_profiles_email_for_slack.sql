alter table public.profiles
add column if not exists email text;

update public.profiles p
set email = lower(u.email)
from auth.users u
where p.id = u.id
  and u.email is not null
  and (p.email is null or p.email <> lower(u.email));

create unique index if not exists profiles_email_unique_idx
on public.profiles (lower(email));

create index if not exists team_memberships_user_active_idx
on public.team_memberships (user_id, is_active);

create index if not exists teams_active_idx
on public.teams (is_active);
