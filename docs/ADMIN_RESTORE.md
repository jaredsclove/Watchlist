# Admin restore (runbook)

For when a library must be restored and the page or sign-in can't be used. It runs the same
database function as the page (`restore_backup`), as the member, from the Supabase SQL Editor, and
it keeps the page's safeguards as explicit steps. It is not a production step without its own
approval. Since M1 there is no schema rollback (plan D2): a restore from a backup is the
recovery path.

Tools: `node tools/admin-restore.mjs` (offline; it never connects to anything). Every check uses the
page's own code.

1. **Validate the file offline.** Keep the backup file you mean to restore. `check` (step 4) validates
   it, and converts a format-3 or format-4 file exactly as the page does.
2. **Confirm the destination account.** In the SQL Editor:
   `select id, email from auth.users where lower(email) = lower('<email>');`
   The owner confirms that this id is the account to restore into, and that it is a member
   (`select * from private.library_members where user_id = '<id>';`).
3. **Take a fresh safety backup.** `node tools/admin-restore.mjs export-sql --owner <id>` prints a
   read-only query that runs as that member, all in one snapshot. Run it, save the single value as `safety.json`.
   It refuses (no value) if the account is not a member at that moment: a non-member reads no rows, and an
   empty file must never stand in for their library.
4. **Check, refusing as the page refuses.**
   `node tools/admin-restore.mjs check --file <backup.json> --safety safety.json [--out converted.json]`
   validates the safety backup and the file, converts if needed, checks any conversion record or
   recovery section, then compares the file with the safety backup for identity loss. **Any
   finding stops the runbook. There is no override:** bypassing the identity-loss refusal would be
   removing a safeguard, which needs its own proposal and the owner's explicit authorization.
5. **Restore.** `node tools/admin-restore.mjs restore-sql --file <the checked format-5 file> --owner <id> --email <email> --run <fresh run id>`
   prints one transaction: a run label, the destination check (that id is that email and a
   member), then `restore_backup` as that member. Check the printed file hash, paste, run.
6. **Verify.** Export again (step 3's query) as `after.json`, then
   `node tools/admin-restore.mjs verify --file <the checked file> --after after.json`.

**No answer in step 5.** The outcome is unknown; never rerun blindly. While a session with
`application_name = 'watchlist-restore-<run id>'` appears in `pg_stat_activity` in any state
(active, waiting, idle in transaction), the transaction hasn't ended. Only once that label has been
seen and is then gone has it ended; a fresh export (step 3) then shows what the library holds. If
the label was never seen, the outcome stays unknown: stop and report. What the library matches is
an observation, not proof that the request did or didn't run.
