-- Self-check harness for the db/test/t_*.sql scripts. Prepend to a test script.
-- Each check runs its body (a DO statement) in a subtransaction that is always
-- rolled back: role switches and any rows the check wrote disappear, so tests
-- leave nothing behind on PGlite or on the Supabase test project. The script
-- ends with one result row per check.
create temp table if not exists _t (seq serial, name text, ok boolean, detail text);
truncate _t;

create or replace function pg_temp.t(p_name text, p_body text) returns void language plpgsql as $f$
begin
  begin
    execute p_body;
    raise exception 'T_ROLLBACK';
  exception when others then
    insert into pg_temp._t (name, ok, detail) values (p_name, sqlerrm = 'T_ROLLBACK', nullif(sqlerrm, 'T_ROLLBACK'));
  end;
end $f$;
