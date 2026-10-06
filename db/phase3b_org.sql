-- Stage 3b-1: personal organization storage, in one transaction.
--   * public.personal_collections: an owner's collections (Disney+, Sheridan, …),
--     separate from the storage tab (`collection`) a row is saved in;
--   * public.collection_memberships: a whole TV show or a film in a collection;
--   * public.watch_with_choices: an owner's watch-with choices. Rows keep storing
--     the choice's token in watch_with; a choice's label can change later without
--     rewriting rows;
--   * watchlist_items.is_film (generated): the positive film rule, so a membership
--     can only ever point at a film;
--   * a temporary trigger: a genuinely new show or film created in Disney+,
--     Sheridan, 90 Day or True Crime / Docs joins that collection, and a TV season
--     matched as a film keeps its show's collections;
--   * restore_backup for backup format 3 only (formats 1 and 2 are refused), and
--     match_tv_row keeping memberships when Match converts a row;
--   * the bootstrap: the four collections with exactly what is stored in each tab
--     today, and one watch-with choice per configured or used value.
-- Every existing row keeps its content; the transaction checks that before it
-- commits. Run as postgres at stage final, after a fresh validated backup.
-- Rollback (guarded; refuses if the organization changed): db/rollback/phase3b.sql.
begin;
set local lock_timeout = '5s';

do $$ begin
  if private.tv_stage() <> 'final' then raise exception 'phase3b: expected stage final, found %', private.tv_stage(); end if;
  if to_regclass('public.personal_collections') is not null then
    raise exception 'phase3b: already applied (personal_collections exists)';
  end if;
end $$;

-- App requests wait (up to the lock timeout) instead of interleaving: a show or
-- film created while this runs is either in the bootstrap or passes the trigger.
lock table public.tv_shows, public.watchlist_items in access exclusive mode;

-- Content of every existing table before any change (everything except user_id).
create temporary table phase3b_before on commit drop as select
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.watchlist_items t) w,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.tv_shows t) s,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.othertv_shows t) o,
  (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.custom_collections t) c;

-- ── Film rule and foreign-key targets on the existing tables ──
alter table public.watchlist_items add column is_film boolean not null
  generated always as (coalesce(media_type = 'movie', false) or (media_type is null and season = 'Film')) stored;
create unique index watchlist_items_id_owner_film_key on public.watchlist_items using btree (id, user_id, is_film);
alter table public.tv_shows add constraint tv_shows_id_owner_key unique (id, user_id);

-- ── Tables ──
create table public.personal_collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id(),
  name text not null,
  legacy_source text,
  sort_order integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  constraint personal_collections_name_check check (name = btrim(name) and name <> '' and char_length(name) <= 100),
  constraint personal_collections_legacy_source_check check (legacy_source in ('disney', 'sheridan', '90day', 'truecrime')),
  constraint personal_collections_id_owner_key unique (id, user_id)
);
-- Names are unique per owner ignoring case, archived collections included.
create unique index personal_collections_name_key on public.personal_collections using btree (user_id, lower(name));
create unique index personal_collections_legacy_source_key on public.personal_collections using btree (user_id, legacy_source)
  where (legacy_source is not null);

create table public.collection_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id(),
  collection_id uuid not null,
  show_id uuid,
  item_id uuid,
  item_is_film boolean generated always as (case when item_id is not null then true end) stored,
  created_at timestamptz not null default now(),
  constraint collection_memberships_target_check check ((show_id is null) <> (item_id is null)),
  constraint collection_memberships_collection_fkey foreign key (collection_id, user_id)
    references public.personal_collections (id, user_id) on delete restrict deferrable initially immediate,
  constraint collection_memberships_show_fkey foreign key (show_id, user_id)
    references public.tv_shows (id, user_id) on delete cascade deferrable initially immediate,
  constraint collection_memberships_item_fkey foreign key (item_id, user_id, item_is_film)
    references public.watchlist_items (id, user_id, is_film) on delete cascade deferrable initially immediate
);
create unique index collection_memberships_show_key on public.collection_memberships using btree (collection_id, show_id)
  where (show_id is not null);
create unique index collection_memberships_item_key on public.collection_memberships using btree (collection_id, item_id)
  where (item_id is not null);
create index collection_memberships_show_id_idx on public.collection_memberships using btree (show_id);
create index collection_memberships_item_id_idx on public.collection_memberships using btree (item_id);

create table public.watch_with_choices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default private.current_owner_id(),
  token text not null,
  label text not null,
  sort_order integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  constraint watch_with_choices_text_check check (token = btrim(token) and token <> '' and label = btrim(label) and label <> ''
    and char_length(label) <= 100)
);
create unique index watch_with_choices_token_key on public.watch_with_choices using btree (user_id, token);
-- Labels are unique per owner ignoring case, archived choices included.
create unique index watch_with_choices_label_key on public.watch_with_choices using btree (user_id, lower(label));

-- Same access rules as the other tables until the sign-in project. user_id is
-- never client-writable; legacy_source and token can't be changed once written;
-- memberships are added or removed, never edited.
do $$ declare t text; begin
  foreach t in array array['personal_collections', 'collection_memberships', 'watch_with_choices'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy anon_select on public.%I for select to anon using (true)', t);
    execute format('create policy anon_insert on public.%I for insert to anon with check (true)', t);
    execute format('create policy anon_update on public.%I for update to anon using (true) with check (true)', t);
    execute format('create policy anon_delete on public.%I for delete to anon using (true)', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, delete on public.%I to anon, authenticated', t);
  end loop;
end $$;
grant insert (id, name, legacy_source, sort_order, archived_at, created_at),
      update (name, sort_order, archived_at)
  on public.personal_collections to anon, authenticated;
grant insert (id, collection_id, show_id, item_id, created_at) on public.collection_memberships to anon, authenticated;
grant insert (id, token, label, sort_order, archived_at, created_at),
      update (label, sort_order, archived_at)
  on public.watch_with_choices to anon, authenticated;

-- ── Temporary membership maintenance (until the legacy tabs' create paths retire) ──
-- Fires only for genuinely new rows (AFTER INSERT: skipped duplicates and failed
-- inserts never reach it) and, for a TV season matched as a film, on the update
-- that unlinks it. Never on reads, refreshes or ordinary edits, so a membership
-- removed later is never put back by them. Runs with the caller's rights.
create function private.org_auto_membership() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare v_coll uuid;
begin
  if tg_op = 'UPDATE' then
    -- A TV season matched as a film keeps every collection its show was in.
    insert into public.collection_memberships (collection_id, item_id)
    select m.collection_id, new.id from public.collection_memberships m where m.show_id = old.show_id
    on conflict (collection_id, item_id) where (item_id is not null) do nothing;
    return null;
  end if;
  select c.id into v_coll from public.personal_collections c
  where c.user_id = new.user_id and c.legacy_source = new.collection;
  if v_coll is null then return null; end if;
  if tg_table_name = 'tv_shows' then
    insert into public.collection_memberships (collection_id, show_id) values (v_coll, new.id)
    on conflict (collection_id, show_id) where (show_id is not null) do nothing;
  else
    insert into public.collection_memberships (collection_id, item_id) values (v_coll, new.id)
    on conflict (collection_id, item_id) where (item_id is not null) do nothing;
  end if;
  return null;
end $$;
revoke all on function private.org_auto_membership() from public;

create trigger org_auto_membership_show after insert on public.tv_shows
  for each row execute function private.org_auto_membership();
create trigger org_auto_membership_film after insert on public.watchlist_items
  for each row when (new.is_film) execute function private.org_auto_membership();
create trigger org_carry_membership_to_film after update of show_id on public.watchlist_items
  for each row when (old.show_id is not null and new.show_id is null and new.is_film)
  execute function private.org_auto_membership();

-- Every watch-with token on a row must be one of its owner's choices (no NULL
-- element). The choices it relies on are locked FOR KEY SHARE, so a concurrent
-- delete of one waits for this transaction and then sees the row that uses it
-- (and refuses); a delete that committed first leaves fewer locked choices than
-- tokens, and this write is refused.
create function private.org_check_watch_with() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare v_wanted int; v_found int; v_bad text;
begin
  if new.watch_with is null or cardinality(new.watch_with) = 0 then return new; end if;
  if array_position(new.watch_with, null) is not null then
    raise exception 'watch_with_invalid: a watch-with value is empty' using errcode = '23514';
  end if;
  select count(distinct t) into v_wanted from unnest(new.watch_with) t;
  select count(*) into v_found from (
    select 1 from public.watch_with_choices c where c.user_id = new.user_id and c.token = any(new.watch_with) for key share
  ) x;
  if v_found <> v_wanted then
    select t into v_bad from unnest(new.watch_with) t
    where not exists (select 1 from public.watch_with_choices c where c.user_id = new.user_id and c.token = t) limit 1;
    raise exception 'watch_with_invalid: "%" is not one of your watch-with choices', coalesce(v_bad, '?') using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function private.org_check_watch_with() from public;
create trigger org_check_watch_with before insert or update of watch_with on public.watchlist_items
  for each row execute function private.org_check_watch_with();

-- A choice still used on one of its owner's rows can't be deleted or have its
-- token changed (the reverse of the check above; restore deletes rows first).
create function private.org_guard_watch_with_choice() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare v_n int;
begin
  if tg_op = 'UPDATE' and new.token = old.token then return new; end if;
  select count(*) into v_n from public.watchlist_items w where w.user_id = old.user_id and old.token = any(w.watch_with);
  if v_n > 0 then
    raise exception 'watch_with_in_use: "%" is still used on % saved item(s); remove it from them first', old.token, v_n
      using errcode = '23503';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function private.org_guard_watch_with_choice() from public;
create trigger org_guard_watch_with_choice before delete or update of token on public.watch_with_choices
  for each row execute function private.org_guard_watch_with_choice();

-- ── Bootstrap: the existing organization, for every owner with rows ──
-- Collections and memberships come from what is stored in each tab, never from
-- DEFAULTS, tags, titles or TMDB. Watch-with: the configured choices
-- (WATCH_WITH_OPTIONS in config.js; a test keeps the two lists equal), then any
-- other value found on a row, A–Z.
create function private.org_bootstrap(p_owner uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_config text[] := array['Alone', 'Suzanne', 'Rina', 'Whole Family'];
  v jsonb;
begin
  if exists (select 1 from public.personal_collections where user_id = p_owner)
     or exists (select 1 from public.watch_with_choices where user_id = p_owner) then
    raise exception 'org_bootstrap: owner % already has organization data', p_owner;
  end if;
  insert into public.personal_collections (user_id, name, legacy_source, sort_order)
  values (p_owner, 'Disney+', 'disney', 1), (p_owner, 'Sheridan', 'sheridan', 2),
         (p_owner, '90 Day', '90day', 3), (p_owner, 'True Crime / Docs', 'truecrime', 4);
  insert into public.collection_memberships (user_id, collection_id, show_id)
  select p_owner, c.id, s.id from public.tv_shows s
  join public.personal_collections c on c.user_id = p_owner and c.legacy_source = s.collection
  where s.user_id = p_owner;
  insert into public.collection_memberships (user_id, collection_id, item_id)
  select p_owner, c.id, w.id from public.watchlist_items w
  join public.personal_collections c on c.user_id = p_owner and c.legacy_source = w.collection
  where w.user_id = p_owner and w.is_film;

  if exists (
    select 1 from (select distinct t from (select unnest(v_config) t union
                   select unnest(watch_with) from public.watchlist_items where user_id = p_owner) x) y
    group by lower(t) having count(*) > 1
  ) then
    raise exception 'org_bootstrap: watch-with values differ only by case; an owner decision is needed';
  end if;
  insert into public.watch_with_choices (user_id, token, label, sort_order)
  select p_owner, t, t, row_number() over (order by k, lower(t), t)
  from (
    select t, array_position(v_config, t) k from unnest(v_config) t
    union
    select t, null from (select distinct unnest(watch_with) t from public.watchlist_items where user_id = p_owner) a
    where not (t = any(v_config))
  ) x;

  v := jsonb_build_object(
    'collections', (select count(*) from public.personal_collections where user_id = p_owner),
    'show_memberships', (select count(*) from public.collection_memberships where user_id = p_owner and show_id is not null),
    'film_memberships', (select count(*) from public.collection_memberships where user_id = p_owner and item_id is not null),
    'watch_with_choices', (select count(*) from public.watch_with_choices where user_id = p_owner));
  return v;
end $$;
revoke all on function private.org_bootstrap(uuid) from public, anon, authenticated;

-- ── Restore: backup format 3 only ──
-- Replaces the current owner's rows in one transaction. The membership trigger
-- stays enabled for everyone: whatever it adds while the shows and films go back
-- in is replaced by exactly the backup's memberships, and the result is checked
-- before commit, so a membership the backup deliberately lacks stays absent.
create or replace function public.restore_backup(p_backup jsonb, p_allow_v1_reset boolean default false)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := private.current_owner_id();
  v_version text := p_backup ->> 'formatVersion';
  v_tables jsonb := p_backup -> 'tables';
  v_counts jsonb := p_backup -> 'rowCounts';
  v_expected jsonb := jsonb_build_object(
    'watchlist_items', jsonb_build_array('id','collection','item_key','title','season','theme','display_date',
      'date_sort','watched','status','created_at','watch_with','collections','tmdb_collection_id',
      'tmdb_collection_name','media_type','tmdb_id','season_number','show_id','skipped'),
    'tv_shows', jsonb_build_array('id','collection','title','show_key','tmdb_id','status','created_at'),
    'othertv_shows', jsonb_build_array('id','tmdb_id','title','network','created_at','collection'),
    'custom_collections', jsonb_build_array('id','name','tmdb_person_id','created_at','role'),
    'personal_collections', jsonb_build_array('id','name','legacy_source','sort_order','archived_at','created_at'),
    'collection_memberships', jsonb_build_array('id','collection_id','show_id','item_id','created_at'),
    'watch_with_choices', jsonb_build_array('id','token','label','sort_order','archived_at','created_at'));
  v_table text;
  v_constraint text;
  v_n jsonb := '{}';
  v_k int;
  v_taken boolean;
begin
  if p_backup ->> 'format' is distinct from 'watchlist-tracker-backup' then
    raise exception 'restore_invalid: not a Watchlist backup' using errcode = '22023';
  end if;
  if v_version = '1' then
    raise exception 'restore_invalid: format 1 backups predate TV shows and can no longer be restored' using errcode = '22023';
  elsif v_version = '2' then
    raise exception 'restore_invalid: format 2 backups predate personal collections and can''t be restored here; restore a format 3 backup (made after the personal-collections update) instead'
      using errcode = '22023';
  elsif v_version is distinct from '3' then
    raise exception 'restore_invalid: unsupported backup format %', coalesce(v_version, '(none)') using errcode = '22023';
  end if;
  if private.tv_stage() <> 'final' then
    raise exception 'restore_invalid: format 3 needs stage final, found %', private.tv_stage() using errcode = '22023';
  end if;

  if jsonb_typeof(v_tables) is distinct from 'object' or jsonb_typeof(v_counts) is distinct from 'object'
     or (select array_agg(k order by k collate "C") from jsonb_object_keys(v_tables) k)
        is distinct from (select array_agg(k order by k collate "C") from jsonb_object_keys(v_expected) k) then
    raise exception 'restore_invalid: unexpected set of tables for format %', v_version using errcode = '22023';
  end if;
  for v_table in select jsonb_object_keys(v_expected) loop
    if jsonb_typeof(v_tables -> v_table) is distinct from 'array' then
      raise exception 'restore_invalid: % is not a list of rows', v_table using errcode = '22023';
    end if;
    if (v_counts ->> v_table) is distinct from jsonb_array_length(v_tables -> v_table)::text then
      raise exception 'restore_invalid: rowCounts.% does not match its rows', v_table using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_tables -> v_table) r
      where jsonb_typeof(r) is distinct from 'object'
         or (select array_agg(k order by k collate "C") from jsonb_object_keys(r) k)
            is distinct from (select array_agg(x order by x collate "C") from jsonb_array_elements_text(v_expected -> v_table) x)
    ) then
      raise exception 'restore_invalid: a % row does not have exactly the expected columns', v_table using errcode = '22023';
    end if;
  end loop;

  -- Concurrent writes wait (or time out) rather than interleave with the
  -- replacement; other owners' rows are never touched.
  perform set_config('lock_timeout', '5s', true);
  lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships,
    public.watch_with_choices, public.othertv_shows, public.custom_collections in share row exclusive mode;

  -- Ids that belong to another owner.
  for v_table in select jsonb_object_keys(v_expected) loop
    execute format('select exists (select 1 from public.%I w join jsonb_array_elements($1) r on w.id = (r ->> ''id'')::uuid
                    where w.user_id <> $2)', v_table)
      into v_taken using v_tables -> v_table, v_owner;
    if v_taken then
      raise exception 'restore_id_collision: this backup contains ids already owned by another user; restoring it would keep those ids and break user isolation, so nothing was changed'
        using errcode = '23505';
    end if;
  end loop;

  delete from public.collection_memberships where user_id = v_owner;
  delete from public.watchlist_items where user_id = v_owner;
  delete from public.tv_shows where user_id = v_owner;
  delete from public.personal_collections where user_id = v_owner;
  delete from public.watch_with_choices where user_id = v_owner;
  delete from public.othertv_shows where user_id = v_owner;
  delete from public.custom_collections where user_id = v_owner;

  begin
    insert into public.watch_with_choices (id, token, label, sort_order, archived_at, created_at)
    select id, token, label, sort_order, archived_at, created_at
    from jsonb_to_recordset(v_tables -> 'watch_with_choices') as x(id uuid, token text, label text, sort_order integer,
      archived_at timestamptz, created_at timestamptz);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('watch_with_choices', v_k);

    insert into public.personal_collections (id, name, legacy_source, sort_order, archived_at, created_at)
    select id, name, legacy_source, sort_order, archived_at, created_at
    from jsonb_to_recordset(v_tables -> 'personal_collections') as x(id uuid, name text, legacy_source text,
      sort_order integer, archived_at timestamptz, created_at timestamptz);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('personal_collections', v_k);

    insert into public.tv_shows (id, collection, title, show_key, tmdb_id, status, created_at)
    select id, collection, title, show_key, tmdb_id, status, created_at
    from jsonb_to_recordset(v_tables -> 'tv_shows') as x(id uuid, collection text, title text, show_key text,
      tmdb_id integer, status text, created_at timestamptz);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('tv_shows', v_k);

    insert into public.watchlist_items (id, collection, item_key, title, season, theme, display_date, date_sort,
      watched, status, created_at, watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type,
      tmdb_id, season_number, show_id, skipped)
    select id, collection, item_key, title, season, theme, display_date, date_sort, watched, status, created_at,
      watch_with, collections, tmdb_collection_id, tmdb_collection_name, media_type, tmdb_id, season_number,
      show_id, skipped
    from jsonb_to_recordset(v_tables -> 'watchlist_items') as x(id uuid, collection text, item_key text, title text,
      season text, theme text, display_date text, date_sort text, watched boolean, status text, created_at timestamptz,
      watch_with text[], collections text[], tmdb_collection_id integer, tmdb_collection_name text, media_type text,
      tmdb_id integer, season_number integer, show_id uuid, skipped boolean);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('watchlist_items', v_k);

    insert into public.othertv_shows (id, tmdb_id, title, network, created_at, collection)
    select id, tmdb_id, title, network, created_at, collection
    from jsonb_to_recordset(v_tables -> 'othertv_shows') as x(id uuid, tmdb_id integer, title text, network text,
      created_at timestamptz, collection text);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('othertv_shows', v_k);

    insert into public.custom_collections (id, name, tmdb_person_id, created_at, role)
    select id, name, tmdb_person_id, created_at, role
    from jsonb_to_recordset(v_tables -> 'custom_collections') as x(id uuid, name text, tmdb_person_id integer,
      created_at timestamptz, role text);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('custom_collections', v_k);

    -- The backup's memberships are authoritative: drop whatever the trigger added
    -- for the restored shows and films, then put back exactly the backup's.
    delete from public.collection_memberships where user_id = v_owner;
    insert into public.collection_memberships (id, collection_id, show_id, item_id, created_at)
    select id, collection_id, show_id, item_id, created_at
    from jsonb_to_recordset(v_tables -> 'collection_memberships') as x(id uuid, collection_id uuid, show_id uuid,
      item_id uuid, created_at timestamptz);
    get diagnostics v_k = row_count; v_n := v_n || jsonb_build_object('collection_memberships', v_k);
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint like '%\_pkey' then
        raise exception 'restore_id_collision: this backup contains ids already owned by another user; restoring it would keep those ids and break user isolation, so nothing was changed'
          using errcode = '23505';
      end if;
      raise exception 'restore_invalid: the backup repeats a unique value (%), so nothing was changed', v_constraint using errcode = '22023';
    when foreign_key_violation then
      get stacked diagnostics v_constraint = constraint_name;
      raise exception 'restore_invalid: a row in the backup points at something that isn''t in it or has the wrong kind (%), so nothing was changed', v_constraint
        using errcode = '22023';
    when check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      raise exception 'restore_invalid: a row in the backup breaks a rule (%: %), so nothing was changed', coalesce(nullif(v_constraint, ''), 'check'), sqlerrm
        using errcode = '22023';
  end;

  if exists (
    select 1 from public.watchlist_items
    where user_id = v_owner and show_id is null and private.tv_is_tv_row(collection, media_type, season)
  ) then
    raise exception 'restore_invalid: every TV season must belong to a show in this backup' using errcode = '22023';
  end if;
  -- Exactly the backup's memberships, nothing added and nothing missing.
  if (select count(*) from public.collection_memberships where user_id = v_owner)
       <> jsonb_array_length(v_tables -> 'collection_memberships')
     or exists (
       select 1 from jsonb_to_recordset(v_tables -> 'collection_memberships') as x(id uuid, collection_id uuid, show_id uuid, item_id uuid)
       where not exists (select 1 from public.collection_memberships m where m.id = x.id and m.user_id = v_owner
                         and m.collection_id = x.collection_id and m.show_id is not distinct from x.show_id
                         and m.item_id is not distinct from x.item_id)) then
    raise exception 'restore_invalid: the restored memberships differ from the backup' using errcode = '22023';
  end if;

  return jsonb_build_object('formatVersion', 3, 'restored', v_n);
end
$$;

revoke all on function public.restore_backup(jsonb, boolean) from public;
grant execute on function public.restore_backup(jsonb, boolean) to anon, authenticated;

-- ── Match to TMDB keeps memberships ──
-- Same identity, conflict and status rules as before (db/rpc.sql). New: the
-- collections the row is visible in move with it.
--   * matched into a new show: the new show gets exactly those collections;
--   * matched into a show already on the list: that show joins any of them it
--     isn't in yet, which shows ALL its stored seasons there. That expansion is
--     never applied silently: p_expansion null (an older page) refuses it with an
--     error and changes nothing; {} answers {blocked, reason: membership_expansion,
--     confirmation} and changes nothing; {"confirm": <that confirmation>} applies
--     it only if the expansion is still exactly the one confirmed (else a fresh
--     blocked answer).
--   * matched in place (its legacy show becomes the TMDB show): unchanged.
-- A TV season matched as a film is the app's PATCH; the trigger above handles it.
drop function public.match_tv_row(uuid, jsonb, jsonb);
create function public.match_tv_row(p_row_id uuid, p_target jsonb, p_patch jsonb, p_expansion jsonb default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid := private.current_owner_id();
  v_stage text := private.tv_require_stage('match_tv_row', 'final');
  r public.watchlist_items;
  v_tmdb integer;
  v_num integer;
  v_label text;
  v_key text;
  v_l public.tv_shows;
  v_t public.tv_shows;
  v_conflict uuid;
  v_target_show uuid;
  v_visible uuid[];
  v_extra uuid[];
  v_token text;
  v_created boolean := false;
begin
  if p_expansion is not null and (jsonb_typeof(p_expansion) <> 'object'
     or (p_expansion ? 'confirm' and jsonb_typeof(p_expansion -> 'confirm') not in ('string', 'null'))) then
    raise exception 'invalid_input: p_expansion %', p_expansion using errcode = '22023';
  end if;
  begin
    v_tmdb := (p_target ->> 'tmdb_id')::integer;
    v_num := (p_patch ->> 'season_number')::integer;
  exception when others then raise exception 'invalid_input: tmdb_id / season_number' using errcode = '22023'; end;
  v_label := case when v_num = 0 then 'Specials' else 'Season ' || v_num end;
  v_key := lower(btrim(coalesce(p_patch ->> 'title', '')));
  if v_tmdb is null or v_num is null or v_num < 0 or v_key = ''
     or p_patch ->> 'media_type' is distinct from 'tv' or (p_patch ->> 'tmdb_id')::integer is distinct from v_tmdb
     or p_patch ->> 'season' is distinct from v_label or p_patch ->> 'item_key' is distinct from v_key || '|' || lower(v_label)
     or not private.tv_valid_date(p_patch ->> 'date_sort') then
    raise exception 'invalid_input: match patch %', p_patch using errcode = '22023';
  end if;

  select * into r from public.watchlist_items
  where id = p_row_id and user_id = v_owner and collection = any(private.tv_collections())
    and tmdb_id is null and media_type is null and season_number is null;
  if r.id is null then raise exception 'not_found: unidentified row' using errcode = 'P0002'; end if;

  select id into v_conflict from public.watchlist_items
  where user_id = v_owner and collection = r.collection and media_type = 'tv' and tmdb_id = v_tmdb and season_number = v_num;
  if found then raise exception 'match_conflict: identity already on the list as row %', v_conflict using errcode = '23505'; end if;
  select id into v_conflict from public.watchlist_items
  where user_id = v_owner and collection = r.collection and tmdb_id is null and item_key = p_patch ->> 'item_key' and id <> r.id;
  if found then raise exception 'match_conflict: item_key already used by row %', v_conflict using errcode = '23505'; end if;

  if r.show_id is not null then
    select * into v_l from public.tv_shows where id = r.show_id and user_id = v_owner for update;
  end if;
  select * into v_t from public.tv_shows
  where user_id = v_owner and collection = r.collection and tmdb_id = v_tmdb for update;
  -- Fix what the decision depends on for this transaction, in the usual order
  -- (shows, then the row, then memberships): the row itself, and the memberships
  -- (a short table lock: membership writes from other sessions wait until this
  -- commits; a change committed before it is read below). So nothing removed
  -- meanwhile is transferred, nothing added meanwhile is dropped, and the expansion
  -- confirmed below is exactly the one applied. Reads are not blocked.
  perform set_config('lock_timeout', '5s', true);
  select * into r from public.watchlist_items
  where id = r.id and tmdb_id is null and media_type is null and season_number is null for update;
  if r.id is null then raise exception 'match_conflict: the row changed; try again' using errcode = '40001'; end if;
  lock table public.collection_memberships in share row exclusive mode;

  -- The collections the row is visible in now: a film's own, or its show's.
  if r.is_film then
    select coalesce(array_agg(collection_id order by collection_id), '{}') into v_visible
    from public.collection_memberships where item_id = r.id;
  elsif v_l.id is not null then
    select coalesce(array_agg(collection_id order by collection_id), '{}') into v_visible
    from public.collection_memberships where show_id = v_l.id;
  else
    v_visible := '{}';
  end if;

  if v_t.id is not null then
    if v_l.id is not null and v_t.status <> v_l.status then
      return jsonb_build_object('blocked', true, 'legacy_status', v_l.status, 'target_status', v_t.status,
                                'legacy_show_id', v_l.id, 'target_show_id', v_t.id);
    end if;
    v_target_show := v_t.id;
    select coalesce(array_agg(c order by c), '{}') into v_extra from unnest(v_visible) c
    where not exists (select 1 from public.collection_memberships m where m.show_id = v_t.id and m.collection_id = c);
    if cardinality(v_extra) > 0 then
      v_token := md5(v_t.id::text || '|' || array_to_string(v_extra, ',') || '|' ||
        coalesce((select string_agg(w.id::text, ',' order by w.id) from public.watchlist_items w where w.show_id = v_t.id), ''));
      if p_expansion is null then
        raise exception 'match_needs_confirmation: matching this row would also show all % stored seasons of "%" in %. This page can''t confirm that; reload it and match again. Nothing was changed.',
          (select count(*) from public.watchlist_items w where w.show_id = v_t.id), v_t.title,
          (select string_agg(c.name, ', ' order by c.sort_order, c.name) from public.personal_collections c where c.id = any(v_extra))
          using errcode = 'P0001';
      end if;
      if (p_expansion ->> 'confirm') is distinct from v_token then
        return jsonb_build_object('blocked', true, 'reason', 'membership_expansion', 'target_show_id', v_t.id,
          'show_title', v_t.title, 'seasons', (select count(*) from public.watchlist_items w where w.show_id = v_t.id),
          'collections', (select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.sort_order, c.name)
                          from public.personal_collections c where c.id = any(v_extra)),
          'confirmation', v_token, 'changed', (p_expansion ->> 'confirm') is not null);
      end if;
    end if;
  elsif v_l.id is not null and not exists (select 1 from public.watchlist_items where show_id = v_l.id and id <> r.id) then
    update public.tv_shows set tmdb_id = v_tmdb, title = btrim(p_patch ->> 'title'), show_key = v_key where id = v_l.id;
    v_target_show := v_l.id;
  else
    insert into public.tv_shows (collection, title, show_key, tmdb_id, status)
    values (r.collection, btrim(p_patch ->> 'title'), v_key, v_tmdb, coalesce(v_l.status, 'confirmed'))
    returning id into v_target_show;
    v_created := true;
  end if;

  -- Memberships move with the row (none of this runs for an in-place match).
  if v_created then
    delete from public.collection_memberships where show_id = v_target_show; -- the trigger's default, if any
  end if;
  if v_target_show is distinct from v_l.id then
    insert into public.collection_memberships (collection_id, show_id)
    select c, v_target_show from unnest(v_visible) c
    on conflict (collection_id, show_id) where (show_id is not null) do nothing;
  end if;
  if r.is_film then
    delete from public.collection_memberships where item_id = r.id; -- before it stops being a film
  end if;

  update public.watchlist_items set
    title = p_patch ->> 'title', season = p_patch ->> 'season', item_key = p_patch ->> 'item_key',
    theme = coalesce(p_patch ->> 'theme', theme), display_date = coalesce(p_patch ->> 'display_date', display_date),
    date_sort = p_patch ->> 'date_sort', media_type = 'tv', tmdb_id = v_tmdb, season_number = v_num, show_id = v_target_show
  where id = r.id and user_id = v_owner and tmdb_id is null and media_type is null and season_number is null
  returning * into r;
  if r.id is null then raise exception 'match_conflict: the row changed; try again' using errcode = '40001'; end if;

  if v_l.id is not null and v_l.id <> v_target_show and not exists (select 1 from public.watchlist_items where show_id = v_l.id) then
    delete from public.tv_shows where id = v_l.id;
  end if;
  return jsonb_build_object('blocked', false, 'row', to_jsonb(r) - 'is_film', 'show_id', v_target_show);
end $$;
revoke all on function public.match_tv_row(uuid, jsonb, jsonb, jsonb) from public;
grant execute on function public.match_tv_row(uuid, jsonb, jsonb, jsonb) to anon, authenticated;

-- ── Bootstrap and verify before commit ──
do $$
declare
  v_owner uuid;
  v_before record;
  v_after record;
  v jsonb;
begin
  for v_owner in select distinct user_id from (select user_id from public.watchlist_items union select user_id from public.tv_shows) o loop
    v := private.org_bootstrap(v_owner);
    raise notice 'org_bootstrap %: %', v_owner, v;
  end loop;

  -- Every existing row is unchanged (the new generated column aside).
  select * into v_before from phase3b_before;
  select
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id' - 'is_film')::text, '|' order by t.id), '')) from public.watchlist_items t) w,
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.tv_shows t) s,
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.othertv_shows t) o,
    (select md5(coalesce(string_agg((to_jsonb(t) - 'user_id')::text, '|' order by t.id), '')) from public.custom_collections t) c
  into v_after;
  if v_after.w <> v_before.w or v_after.s <> v_before.s or v_after.o <> v_before.o or v_after.c <> v_before.c then
    raise exception 'phase3b: existing rows changed';
  end if;
  -- is_film is exactly the app's film rule (isFilmRow).
  if exists (select 1 from public.watchlist_items
             where is_film is distinct from (coalesce(media_type = 'movie', false) or (media_type is null and season = 'Film'))) then
    raise exception 'phase3b: is_film differs from the film rule';
  end if;
  -- Memberships are exactly what each mapped tab stores: no more, no less.
  if exists (
    (select c.id, s.id, null::uuid from public.tv_shows s join public.personal_collections c
       on c.user_id = s.user_id and c.legacy_source = s.collection
     union all
     select c.id, null::uuid, w.id from public.watchlist_items w join public.personal_collections c
       on c.user_id = w.user_id and c.legacy_source = w.collection where w.is_film)
    except
    select collection_id, show_id, item_id from public.collection_memberships
  ) or exists (
    select collection_id, show_id, item_id from public.collection_memberships
    except
    (select c.id, s.id, null::uuid from public.tv_shows s join public.personal_collections c
       on c.user_id = s.user_id and c.legacy_source = s.collection
     union all
     select c.id, null::uuid, w.id from public.watchlist_items w join public.personal_collections c
       on c.user_id = w.user_id and c.legacy_source = w.collection where w.is_film)
  ) then
    raise exception 'phase3b: memberships differ from what the tabs store';
  end if;
  -- Every watch-with token on a row is a choice of its owner.
  if exists (select 1 from public.watchlist_items w, unnest(coalesce(w.watch_with, '{}'::text[])) t
             where not exists (select 1 from public.watch_with_choices c where c.user_id = w.user_id and c.token = t)) then
    raise exception 'phase3b: a watch-with value has no choice';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
