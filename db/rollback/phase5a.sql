-- Rollback of Stage 5a (db/phase5a_expand.sql), in one transaction. Refuses unless
-- Stage 5a is installed and the database is still in coexistence (after the
-- contraction, db/rollback/phase5c.sql comes first). Run only after the app no
-- longer calls the library_* functions (revert the app first: a Stage 5 page then
-- reports that the database needs an update and writes nothing).
-- Drops what 5a added — the library_* functions, stage5_capabilities, the read
-- views, the library-wide identity indexes and the private helpers — and puts
-- back the Stage 4a catalog_apply exactly (applies work again for old pages).
-- Every row stays: records created through the library_* functions during
-- coexistence carry ordinary storage values and remain valid Stage 4b data.
-- Never part of a reinstall sequence; doesn't touch db/rpc.sql. Run as postgres.
-- Bound to the G3 baseline (Stage 5 plan §3(b)): the session setting
-- watchlist.rollback5a_baseline must hold the exact G3 function inventory (the
-- read-only inventory captured from production before 5a, SHA-256 pinned below),
-- set by a one-statement preamble run just before this file in the same run
-- (db/README.md, "Rollback 5a"). Without it, or with any other text, the rollback
-- refuses before changing anything. Before commit, the restored Stage 4b
-- catalog_apply (source md5) and the whole function and trigger inventory are
-- compared with the baseline; any difference aborts the transaction. On success
-- the setting is cleared.
begin;
set local lock_timeout = '5s';

-- ── G3 baseline: present and exactly the pinned inventory ─────────────────────
do $$
declare
  v text := current_setting('watchlist.rollback5a_baseline', true);
  b jsonb;
begin
  if v is null or v = '' then
    raise exception 'phase5a rollback: baseline missing: set watchlist.rollback5a_baseline to the exact G3 inventory first (db/README.md, "Rollback 5a"); nothing was changed';
  end if;
  if encode(sha256(convert_to(v, 'UTF8')), 'hex') <> '180b5fb5b3dd207f2b2a53e8eb28742e83887cb69f040968b82eacc6fb4a0513' then
    raise exception 'phase5a rollback: baseline invalid: it is not the exact G3 inventory (SHA-256 180b5fb5…); nothing was changed';
  end if;
  b := v::jsonb;
  if b ->> 'stage' is distinct from 'final' or jsonb_typeof(b -> 'functions') is distinct from 'object'
     or jsonb_typeof(b -> 'triggers') is distinct from 'object'
     or b -> 'functions' -> 'public.catalog_apply(p_collection text, p_defaults jsonb, p_approved text)' ->> 'src'
        is distinct from 'dc1340858176341f05eb7018b7e8c747' then
    raise exception 'phase5a rollback: baseline invalid: not a Stage 4b inventory with G3''s catalog_apply; nothing was changed';
  end if;
end $$;

do $$ begin
  if to_regprocedure('public.stage5_capabilities()') is null then raise exception 'phase5a rollback: Stage 5a is not installed'; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'coexistence' then
    raise exception 'phase5a rollback: the database is %; roll back the contraction first (db/rollback/phase5c.sql)', public.stage5_capabilities() ->> 'phase';
  end if;
end $$;

drop function public.library_catalog_apply(text, jsonb, text);
drop function private.catalog_run5(text, jsonb);
drop function private.lib_catalog_candidates(uuid, text, text, text, text);
drop function public.library_match_film(uuid, jsonb, jsonb);
drop function public.library_match_season(uuid, jsonb, jsonb, jsonb);
drop function private.lib_match_row(uuid, uuid);
drop function public.library_create_film(jsonb);
drop function public.library_add_films(jsonb);
drop function private.lib_valid_film(jsonb, boolean);
drop function public.library_create_show(jsonb, jsonb);
drop function public.library_add_seasons(uuid, jsonb, jsonb);
drop function public.stage5_capabilities();
drop function private.lib_match_season_core(public.watchlist_items, jsonb, jsonb, jsonb);
drop function private.lib_film_match_update(uuid, jsonb, integer, integer, text);
drop function private.lib_insert_film(uuid, jsonb, text);
drop function private.lib_add_to_show(public.tv_shows, text, jsonb, boolean);
drop function private.lib_new_show_row(uuid, text, text, integer, text);
drop function private.lib_catalog_insert(uuid, text, jsonb);
drop function private.lib_catalog_lock();
drop function private.lib_catalog_target(uuid, text);
drop function private.lib_set_theme_kind(uuid, text);
drop function private.lib_film_theme_kind(uuid);
drop function private.lib_film_catalog(uuid);
drop function private.lib_show_catalog(uuid);
drop function private.lib_refuse_twins(uuid[], text, text);
drop function private.lib_catalog_twins(uuid, text, text, text, uuid[]);
drop function private.lib_distinct_ids(jsonb);
drop function private.lib_refuse(text, text);
drop function private.lib_write_on();
drop function private.lib_catalogs();
drop view public.library_collection_presentation;
drop view public.library_collection_catalogs;
drop view public.library_film_theme_kinds;
drop view public.library_catalog_films;
drop view public.library_catalog_shows;
drop index public.watchlist_items_show_item_key;
drop index public.watchlist_items_library_tv_key;
drop index public.watchlist_items_library_movie_key;
drop index public.tv_shows_library_identity_key;

-- Stage 4a's catalog_apply, verbatim (db/phase4a_catalog.sql).
create or replace function public.catalog_apply(p_collection text, p_defaults jsonb, p_approved text default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v jsonb;
begin
  perform private.tv_require_stage('catalog_apply', 'final');
  begin
    if p_approved is null then
      begin
        v := private.catalog_run(p_collection, p_defaults);
        raise exception 'catalog_preview_rollback' using errcode = 'P0001';
      exception when sqlstate 'P0001' then
        if sqlerrm <> 'catalog_preview_rollback' then raise; end if;
      end;
      return jsonb_build_object('mode', 'preview', 'document', v -> 'document', 'hash', v ->> 'hash');
    end if;
    v := private.catalog_run(p_collection, p_defaults);
  exception when lock_not_available or deadlock_detected then
    raise exception 'catalog_busy: The database was busy, so nothing was changed. Review again in a moment.' using errcode = 'P0001';
  end;
  if v ->> 'hash' is distinct from p_approved then
    raise exception 'catalog_stale: Your library or the catalog changed since this preview, so nothing was changed. Review again.'
      using errcode = 'P0001', detail = jsonb_build_object('hash', v ->> 'hash')::text;
  end if;
  return jsonb_build_object('mode', 'applied', 'document', v -> 'document', 'hash', v ->> 'hash', 'receipt', v -> 'receipt',
    'applied_at', now());
end $$;

-- ── Stage 4b restored: equal to the G3 baseline before commit ─────────────────
-- The inventory has the scope of the G3 capture: every public/private function
-- (signature, source md5, grants, security mode, configuration), every trigger on
-- the public tables, and the stage. Compared structurally (as jsonb), not as text.
do $$
declare
  b jsonb := current_setting('watchlist.rollback5a_baseline')::jsonb;
  cur jsonb;
  ca text := md5(pg_get_functiondef('public.catalog_apply(text, jsonb, text)'::regprocedure));
  missing text; extra text; changed text; trig text;
begin
  if ca is distinct from 'dc1340858176341f05eb7018b7e8c747' then
    raise exception 'phase5a rollback: the restored catalog_apply source (md5 %) is not G3''s (dc134085…); nothing was changed', ca;
  end if;
  select jsonb_build_object(
    'stage', (select private.tv_stage()),
    'functions', (select jsonb_object_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
        jsonb_build_object('src', md5(pg_get_functiondef(p.oid)), 'acl', coalesce(p.proacl::text, ''), 'secdef', p.prosecdef,
          'config', coalesce(array_to_string(p.proconfig, ','), '')))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prokind = 'f' and p.proname not like 'zz\_%'),
    'triggers', (select jsonb_object_agg(c.relname || '.' || t.tgname, t.tgenabled::text || ' ' || md5(pg_get_triggerdef(t.oid)))
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relnamespace = 'public'::regnamespace)) into cur;
  select string_agg(k, '; ' order by k) into missing
    from jsonb_object_keys(b -> 'functions') k where not coalesce(cur -> 'functions' ? k, false);
  select string_agg(k, '; ' order by k) into extra
    from jsonb_object_keys(coalesce(cur -> 'functions', '{}')) k where not (b -> 'functions' ? k);
  select string_agg(k || ' (' || (select string_agg(a, ',' order by a) from
      (select jsonb_object_keys(b -> 'functions' -> k) a union select jsonb_object_keys(cur -> 'functions' -> k)) s
      where (b -> 'functions' -> k -> a) is distinct from (cur -> 'functions' -> k -> a)) || ')', '; ' order by k) into changed
    from jsonb_object_keys(b -> 'functions') k
    where coalesce(cur -> 'functions' ? k, false) and (b -> 'functions' -> k) is distinct from (cur -> 'functions' -> k);
  select string_agg(k, '; ' order by k) into trig
    from (select jsonb_object_keys(b -> 'triggers') k union select jsonb_object_keys(coalesce(cur -> 'triggers', '{}'))) s
    where (b -> 'triggers' -> k) is distinct from (cur -> 'triggers' -> k);
  if missing is not null or extra is not null or changed is not null or trig is not null
     or (cur ->> 'stage') is distinct from (b ->> 'stage') then
    raise exception 'phase5a rollback: the restored inventory differs from G3, nothing was changed: missing [%], extra [%], changed [%], triggers [%], stage % (G3 %)',
      coalesce(missing, ''), coalesce(extra, ''), coalesce(changed, ''), coalesce(trig, ''), cur ->> 'stage', b ->> 'stage';
  end if;
  perform set_config('watchlist.rollback5a_baseline', '', false);
end $$;

notify pgrst, 'reload schema';
commit;
