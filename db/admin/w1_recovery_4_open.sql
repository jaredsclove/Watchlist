-- W1 recovery, step 4 of 5: open the API. Run as postgres, only after step 3's checks passed. Then prove it: an ordinary
-- token works and its direct write is refused. Until PostgREST reloads, the gate stays in force and ordinary requests stay
-- refused, so a failed reload shows up as an API that is still closed.
alter role authenticator reset pgrst.db_pre_request;
notify pgrst, 'reload config';
