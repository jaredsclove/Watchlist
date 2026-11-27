-- BK1c: a replaced author credit (books item 6, after BK1b). One transaction, run as postgres on a database with BK1b.
-- Preamble, in the same run and before this file:
--   select set_config('watchlist.bk1c_run', '<a fresh run id, recorded before running>', false);
-- Review's credit correction saved only "this book is also by this author" (book_associations), so Hardcover's wrong credit (a
-- publisher, the owner's report 2026-11-27) stayed beside the corrected author. A replacement is now its own decision: a
-- book_decisions row of the new kind 'replace_credit', key 'rc:<Hardcover book id>:<replaced Hardcover author id>', value
-- {by: <credited Hardcover author id>}. The page omits that one credit only while the member's credit to `by` for that book
-- exists; an association without it keeps its additive meaning. Hardcover's record and the saved entry are never changed.
-- What it changes:
--   * book_decisions' kind and value checks (the new kind; its key and value checked by private.bk1c_replace_ok).
--   * public.library_book_decision_set: takes the new kind; otherwise as BK1b.
-- Nothing else: no table, column, capability, phase or backup-format change (a replacement is a decision row, in backups as the
-- others are; a format-10 file restores as before). Existing rows are fingerprinted unchanged.
-- Completion: committed if and only if private.migration_runs holds its run id (a fresh read in a separate execution). Never rerun
-- to find out; a rerun is refused once this committed. No rollback (fix-forward); BK1b's definitions are in git.
begin;
select set_config('application_name', 'watchlist-bk1c-' || coalesce(nullif(current_setting('watchlist.bk1c_run', true), ''), 'unset'), true);
set local lock_timeout = '10s';
lock table private.migration_runs in access exclusive mode;
do $$
begin
  if exists (select 1 from private.migration_runs r where r.migration = 'bk1c') then raise exception 'bk1c: already installed; nothing was changed'; end if;
end $$;
lock table public.book_entries, public.book_follows, public.book_sites, public.book_associations, public.book_decisions, public.book_findings in share row exclusive mode;

-- ── 1. Preconditions and the before-state ─────────────────────────────────────
create temp table bk1c_ctx on commit drop as
select nullif(current_setting('watchlist.bk1c_run', true), '') as run_id,
  (select md5(coalesce(string_agg(x, '|' order by x), '')) from (
     select to_jsonb(r)::text x from public.book_entries r union all select to_jsonb(r)::text from public.book_follows r
     union all select to_jsonb(r)::text from public.book_sites r union all select to_jsonb(r)::text from public.book_associations r
     union all select to_jsonb(r)::text from public.book_decisions r union all select to_jsonb(r)::text from public.book_findings r) q) as books_before;
do $$
declare c record;
begin
  select * into c from bk1c_ctx;
  if c.run_id is null or c.run_id !~ '^[A-Za-z0-9_-]{6,64}$' then raise exception 'bk1c: set watchlist.bk1c_run (6–64 letters, digits, _ or -) first; nothing was changed'; end if;
  if exists (select 1 from private.migration_runs r where r.run_id = c.run_id) then raise exception 'bk1c: run id % is already recorded; use a fresh one. Nothing was changed', c.run_id; end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-bk1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '10'
     or not exists (select 1 from private.migration_runs r where r.migration = 'bk1b') then
    raise exception 'bk1c: expected BK1b (phase contracted-bk1, backup format 10); nothing was changed';
  end if;
  if (select pg_get_constraintdef(oid) from pg_constraint where conname = 'book_decisions_kind_check' and conrelid = 'public.book_decisions'::regclass) ~ 'replace_credit' then
    raise exception 'bk1c: book_decisions already takes replaced credits; nothing was changed';
  end if;
end $$;

-- ── 2. The new kind ────────────────────────────────────────────────────────────
-- A replaced credit: key 'rc:<book id>:<replaced author id>', value {by: <credited author id>}, positive integers, by not the
-- replaced author, nothing else (never null: a check constraint would pass it).
create function private.bk1c_replace_ok(p_key text, p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_key is not null and p_key ~ '^rc:[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$' and p is not null and jsonb_typeof(p) = 'object'
     and (select array_agg(k) from jsonb_object_keys(p) k) = array['by'] and jsonb_typeof(p -> 'by') = 'number' and (p ->> 'by') ~ '^[1-9][0-9]{0,9}$'
     and (p ->> 'by')::bigint <= 2147483647 and (p ->> 'by') <> split_part(p_key, ':', 3), false)
$$;
alter table public.book_decisions drop constraint book_decisions_kind_check;
alter table public.book_decisions add constraint book_decisions_kind_check check (kind in ('skip', 'exclude', 'keep_date', 'not_same', 'not_author', 'baseline', 'replace_credit'));
alter table public.book_decisions drop constraint book_decisions_value_check;
alter table public.book_decisions add constraint book_decisions_value_check check (jsonb_typeof(value) = 'object'
  and octet_length(value::text) <= case when kind = 'baseline' then 60000 else 4000 end and (kind <> 'baseline' or private.bk1b_baseline_ok(value))
  and (kind <> 'replace_credit' or private.bk1c_replace_ok(key, value)));

-- ── 3. The decision function takes it ─────────────────────────────────────────
create or replace function public.library_book_decision_set(p_kind text, p_key text, p_expected jsonb, p_value jsonb, p_finding text, p_outcome text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare v_owner uuid := private.current_owner_id(); d public.book_decisions;
begin
  if p_kind is null or p_kind not in ('skip', 'exclude', 'keep_date', 'not_same', 'not_author', 'baseline', 'replace_credit') or not private.bk1_key_ok(p_key)
     or (p_value is not null and (jsonb_typeof(p_value) is distinct from 'object' or octet_length(p_value::text) > case when p_kind = 'baseline' then 60000 else 4000 end))
     or (p_kind = 'baseline' and p_value is not null and not private.bk1b_baseline_ok(p_value))
     or (p_kind = 'replace_credit' and p_value is not null and not private.bk1c_replace_ok(p_key, p_value))
     or (p_finding is not null and not private.bk1_key_ok(p_finding)) or (p_outcome is not null and p_outcome not in ('done', 'later'))
     or ((p_finding is null) <> (p_outcome is null)) then
    raise exception 'invalid_input: decision' using errcode = '22023';
  end if;
  perform private.bk1_lock(v_owner);
  select * into d from public.book_decisions where user_id = v_owner and kind = p_kind and key = p_key;
  if (d.id is null) <> (p_expected is null) or (d.id is not null and d.value is distinct from p_expected) then perform private.b45_changed(); end if;
  perform set_config('watchlist.library_write', 'on', true);
  if p_outcome = 'done' then perform private.bk1_close(v_owner, p_finding);
  elsif p_outcome = 'later' then update public.book_findings set status = 'later' where user_id = v_owner and fingerprint = p_finding;
  end if;
  if p_value is null then
    delete from public.book_decisions where id = d.id;
    return jsonb_build_object('kind', p_kind, 'key', p_key, 'removed', d.id is not null);
  end if;
  if d.id is null then
    insert into public.book_decisions (kind, key, value) values (p_kind, p_key, p_value) returning * into d;
  else
    update public.book_decisions set value = p_value, created_at = now() where id = d.id returning * into d;
  end if;
  return to_jsonb(d) - 'user_id';
end $$;

-- ── 4. Grants and the run record ───────────────────────────────────────────────
revoke all on function private.bk1c_replace_ok(text, jsonb) from public, anon;
grant execute on function private.bk1c_replace_ok(text, jsonb) to authenticated;
revoke all on function public.library_book_decision_set(text, text, jsonb, jsonb, text, text) from public, anon;
grant execute on function public.library_book_decision_set(text, text, jsonb, jsonb, text, text) to authenticated;
insert into private.migration_runs (run_id, migration) select run_id, 'bk1c' from bk1c_ctx;

-- ── 5. Verify before commit ─────────────────────────────────────────────────────
do $$
declare c record;
begin
  select * into c from bk1c_ctx;
  if (select md5(coalesce(string_agg(x, '|' order by x), '')) from (
       select to_jsonb(r)::text x from public.book_entries r union all select to_jsonb(r)::text from public.book_follows r
       union all select to_jsonb(r)::text from public.book_sites r union all select to_jsonb(r)::text from public.book_associations r
       union all select to_jsonb(r)::text from public.book_decisions r union all select to_jsonb(r)::text from public.book_findings r) q) is distinct from c.books_before then
    raise exception 'bk1c: an existing book row changed';
  end if;
  if has_function_privilege('anon', 'public.library_book_decision_set(text, text, jsonb, jsonb, text, text)', 'execute')
     or not has_function_privilege('authenticated', 'public.library_book_decision_set(text, text, jsonb, jsonb, text, text)', 'execute')
     or (select prosecdef from pg_proc where oid = 'public.library_book_decision_set(text, text, jsonb, jsonb, text, text)'::regprocedure)
     or has_function_privilege('anon', 'private.bk1c_replace_ok(text, jsonb)', 'execute') then
    raise exception 'bk1c: a function isn''t executable as designed';
  end if;
  if public.stage5_capabilities() ->> 'phase' is distinct from 'contracted-bk1' or (public.stage5_capabilities() ->> 'backup_format') is distinct from '10' then
    raise exception 'bk1c: the capability changed: %', public.stage5_capabilities();
  end if;
end $$;

select 'BK1C|' || json_build_object('run', (select run_id from bk1c_ctx)) as result;

notify pgrst, 'reload schema';
commit;
