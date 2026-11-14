create sequence if not exists public.lify_sync_version;
create table if not exists public.lify_sync_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('playlist','favorite','preference')),
  entity_key text not null check (length(entity_key) between 1 and 512),
  payload jsonb,
  version bigint not null default nextval('public.lify_sync_version'),
  primary key (user_id,kind,entity_key),
  check (payload is null or octet_length(payload::text) <= 1048576)
);
create index if not exists lify_sync_user_version on public.lify_sync_records(user_id,version);
create table if not exists public.lify_sync_operations (
  user_id uuid not null references auth.users(id) on delete cascade,
  op_id text not null,
  primary key(user_id,op_id)
);
alter table public.lify_sync_records enable row level security;
alter table public.lify_sync_operations enable row level security;
revoke all on public.lify_sync_records, public.lify_sync_operations from anon, authenticated;
grant select on public.lify_sync_records to authenticated;
drop policy if exists lify_read_own_records on public.lify_sync_records;
create policy lify_read_own_records on public.lify_sync_records for select to authenticated using ((select auth.uid())=user_id);

create or replace function public.lify_apply_changes(changes jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); item jsonb; inserted integer;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(changes) <> 'array' or jsonb_array_length(changes) > 100 then raise exception 'Invalid batch'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text,0));
  for item in select value from jsonb_array_elements(changes) loop
    if coalesce(item->>'op_id','') !~ '^[a-f0-9]{32}$' then raise exception 'Invalid operation'; end if;
    insert into public.lify_sync_operations(user_id,op_id) values(v_user,item->>'op_id') on conflict do nothing;
    get diagnostics inserted = row_count;
    if inserted > 0 then
      insert into public.lify_sync_records(user_id,kind,entity_key,payload)
      values(v_user,item->>'kind',item->>'entity_key',nullif(item->'payload','null'::jsonb))
      on conflict(user_id,kind,entity_key) do update set payload=excluded.payload,version=nextval('public.lify_sync_version');
    end if;
  end loop;
end $$;
revoke all on function public.lify_apply_changes(jsonb) from public, anon;
grant execute on function public.lify_apply_changes(jsonb) to authenticated;
do $$ begin
  if not exists(select 1 from pg_publication where pubname='supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='lify_sync_records') then
    alter publication supabase_realtime add table public.lify_sync_records;
  end if;
end $$;
