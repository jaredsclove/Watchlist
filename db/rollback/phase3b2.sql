-- Rollback of Stage 3b-2 (db/phase3b2_org_write.sql), in one transaction.
-- Functions only: drops the 3b-2 write and capability functions and puts back the
-- Stage 3b-1 watch-with check (copied verbatim from db/phase3b_org.sql). Every
-- table and every row is left as it is, so every edit made with 3b-2 stays (new,
-- renamed and archived collections, memberships, choices). Afterwards the database
-- no longer refuses an UPDATE that newly adds an archived watch-with choice.
-- Revert the app to the Stage 3b-1 release first; run as postgres.
begin;
set local lock_timeout = '5s';

do $$ begin
  if to_regprocedure('public.org_capabilities()') is null then
    raise exception 'rollback 3b-2 refused: Stage 3b-2 is not installed';
  end if;
end $$;

drop function public.org_capabilities();
drop function public.org_create_collection(uuid, text);
drop function public.org_rename_collection(uuid, text, text);
drop function public.org_set_collection_archived(uuid, boolean);
drop function public.org_add_membership(uuid, uuid, uuid);
drop function public.org_remove_membership(uuid, uuid, uuid, uuid);
drop function public.org_create_choice(uuid, text);
drop function public.org_rename_choice(uuid, text, text);
drop function public.org_set_choice_archived(uuid, boolean);
drop function private.org_refuse(text, text, jsonb);
drop function private.org_clean_text(text, text);

-- The Stage 3b-1 version, verbatim (db/phase3b_org.sql).
create or replace function private.org_check_watch_with() returns trigger
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

do $$ begin
  if (select md5(prosrc) from pg_proc where oid = 'private.org_check_watch_with()'::regprocedure)
     <> '41520d4ff23d80b4adb5a676ebcd8b7e' then
    raise exception 'rollback 3b-2: private.org_check_watch_with is not the Stage 3b-1 version after the rollback';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
