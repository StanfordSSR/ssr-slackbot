create table if not exists public.schema_catalog_tables (
  id uuid primary key default gen_random_uuid(),
  schema_name text not null default 'public',
  table_name text not null,
  table_kind text not null default 'table',
  description text,
  scope_kind text not null default 'org' check (scope_kind in ('org', 'team', 'admin_only', 'blocked')),
  team_scope_column text,
  access_level text not null default 'standard' check (access_level in ('standard', 'admin_only', 'blocked')),
  semantic_roles text[] not null default '{}',
  preferred_time_column text,
  is_queryable boolean not null default true,
  row_count_hint bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (schema_name, table_name)
);

create table if not exists public.schema_catalog_columns (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.schema_catalog_tables(id) on delete cascade,
  column_name text not null,
  data_type text not null,
  is_nullable boolean not null default true,
  ordinal_position integer,
  description text,
  semantic_roles text[] not null default '{}',
  is_queryable boolean not null default true,
  unique (table_id, column_name)
);

create table if not exists public.schema_catalog_relationships (
  id uuid primary key default gen_random_uuid(),
  from_table_id uuid not null references public.schema_catalog_tables(id) on delete cascade,
  from_column_name text not null,
  to_table_id uuid not null references public.schema_catalog_tables(id) on delete cascade,
  to_column_name text not null,
  relationship_kind text not null default 'foreign_key',
  created_at timestamptz not null default now()
);

create table if not exists public.schema_refresh_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null check (status in ('processing', 'completed', 'failed')),
  refreshed_tables integer not null default 0,
  refreshed_columns integer not null default 0,
  refreshed_relationships integer not null default 0,
  error_text text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.question_sql_queries (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.question_sessions(id) on delete cascade,
  step_index integer not null default 0,
  rationale text,
  proposed_sql text not null,
  executed_sql text,
  sql_fingerprint text,
  referenced_tables text[] not null default '{}',
  row_count integer not null default 0,
  duration_ms integer,
  status text not null check (status in ('proposed', 'executed', 'rejected', 'failed')),
  error_text text,
  result_preview jsonb,
  created_at timestamptz not null default now()
);

create index if not exists schema_catalog_columns_table_idx on public.schema_catalog_columns(table_id);
create index if not exists schema_catalog_relationships_from_idx on public.schema_catalog_relationships(from_table_id);
create index if not exists schema_catalog_relationships_to_idx on public.schema_catalog_relationships(to_table_id);
create index if not exists question_sql_queries_session_idx on public.question_sql_queries(session_id);

drop trigger if exists schema_catalog_tables_set_updated_at on public.schema_catalog_tables;
create trigger schema_catalog_tables_set_updated_at
before update on public.schema_catalog_tables
for each row
execute function public.set_updated_at_timestamp();

create or replace function public.get_live_schema_columns()
returns table (
  schema_name text,
  table_name text,
  table_kind text,
  column_name text,
  data_type text,
  is_nullable boolean,
  ordinal_position integer
)
language sql
security definer
set search_path = public, information_schema, pg_catalog
as $$
  select
    c.table_schema::text as schema_name,
    c.table_name::text as table_name,
    case when t.table_type = 'VIEW' then 'view' else 'table' end::text as table_kind,
    c.column_name::text as column_name,
    c.data_type::text as data_type,
    (c.is_nullable = 'YES') as is_nullable,
    c.ordinal_position::integer as ordinal_position
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = c.table_schema
   and t.table_name = c.table_name
  where c.table_schema = 'public'
    and c.table_name not like 'schema_catalog_%'
    and c.table_name not in ('schema_refresh_runs', 'question_sql_queries')
  order by c.table_name, c.ordinal_position;
$$;

create or replace function public.get_live_schema_relationships()
returns table (
  from_schema text,
  from_table text,
  from_column text,
  to_schema text,
  to_table text,
  to_column text
)
language sql
security definer
set search_path = public, information_schema, pg_catalog
as $$
  select
    tc.table_schema::text as from_schema,
    tc.table_name::text as from_table,
    kcu.column_name::text as from_column,
    ccu.table_schema::text as to_schema,
    ccu.table_name::text as to_table,
    ccu.column_name::text as to_column
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name
   and tc.table_schema = kcu.table_schema
  join information_schema.constraint_column_usage ccu
    on ccu.constraint_name = tc.constraint_name
   and ccu.table_schema = tc.table_schema
  where tc.constraint_type = 'FOREIGN KEY'
    and tc.table_schema = 'public';
$$;

create or replace function public.execute_guarded_sql(
  query_text text,
  max_rows integer default 100,
  timeout_ms integer default 4000
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  normalized text;
  rows_json jsonb;
begin
  if query_text is null or btrim(query_text) = '' then
    raise exception 'Query is required';
  end if;

  normalized := lower(regexp_replace(query_text, '\s+', ' ', 'g'));

  if normalized ~ ';\s*.+'
     or normalized ~ '\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|merge|copy|comment|vacuum|analyze|refresh|execute|call|do)\b'
  then
    raise exception 'Only single read-only SELECT/CTE queries are allowed';
  end if;

  if normalized !~ '^\s*(select|with)\b' then
    raise exception 'Only SELECT/CTE queries are allowed';
  end if;

  perform set_config('statement_timeout', timeout_ms::text, true);

  execute format(
    'select coalesce(jsonb_agg(to_jsonb(q)), ''[]''::jsonb) from (select * from (%s) as inner_q limit %s) q',
    query_text,
    greatest(1, least(max_rows, 200))
  )
  into rows_json;

  return coalesce(rows_json, '[]'::jsonb);
end;
$$;
