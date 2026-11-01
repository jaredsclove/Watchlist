-- W1 recovery, step 5 of 5: remove the gate, once step 4 has proved ordinary requests pass. Run as postgres.
begin;
do $$
begin
  if exists (select 1 from pg_db_role_setting s, unnest(s.setconfig) x where x like 'pgrst.db_pre_request=%') then
    raise exception 'w1 recovery: the gate is still configured; nothing was changed';
  end if;
end $$;
drop function public.w1_repair_gate();
drop table private.w1_recovery;
commit;
