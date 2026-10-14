-- The B45 rollback's dry run: the report db/rollback/b45.sql binds to, read under the
-- rollback's own lock set in a transaction that is rolled back (nothing is written).
-- Returns the report and its SHA-256. The approval of a rollback names that hash (and,
-- when the report lists projected or discarded values, accepts them as lossy).
begin;
set local lock_timeout = '5s';
lock table public.tv_shows, public.watchlist_items, public.personal_collections, public.collection_memberships,
  public.watch_with_choices, public.custom_collections, public.catalog_show_links, public.catalog_film_links in exclusive mode;
lock table private.stage5_recovery_records, private.stage5_recovery_collections, private.stage5_recovery_othertv,
  private.stage5_recovery_meta in exclusive mode;
select x.v as report, encode(sha256(convert_to(x.v::text, 'UTF8')), 'hex') as report_sha256
from (select private.b45_rollback_report() v) x;
rollback;
