# W1 hosted test and recovery procedure

The production test for W1's release and the recovery drill (H2), as approved by the owner. The recovery itself is in
`db/README.md`, write scope; this file says how it is proved on the hosted project, with nothing poisoned. Ids, tokens, backups
and results stay in the owner's private files; none of them belong here.

Each SQL run below is its own run in the SQL Editor, checked against the file's SHA-256 before it runs. Each check runs in a
signed-in tab of the live page, with `tools/w1-hosted-probes.js` in page memory: `const P = W1Probes(W1PageEnv())`. It uses the
page's session and never prints a token.

## 1. Preflight (read-only)

`db/test/w1_preflight.sql`, once, before anything else. Continue only if every line holds.

| Answer | Must be | Why |
|---|---|---|
| `records` | Phase `contracted-cu1`, format 7, runs cu1, cu1b, cu1c, cu1d, cu2, cu1e, no w1, no `lib_authorized` | The baseline |
| `functions` | 38 of 38, 3 enrichment, 0 public writers outside the list | The migration's set |
| `settings` | `content`, `content`, source default, context `user`; 0 defaults; 0 functions naming either; `pre_request_set` false | Nothing already in the way |
| `grants` | No application role can create; `authenticated` uses `private`, `anon` doesn't; `pg_graphql` false | The gate's first half has something to revoke |
| `capabilities` | `postgres` not superuser, `may_signal` true, `admin_of_authenticator` true (on PostgreSQL before 16, `postgres_createrole` is enough), `private_owner` postgres, one owner | `postgres` can end the connections, set the gate and revoke usage |
| `connections` | At least one `PostgREST…` name; any other name is noted and left alone | The connections script ends PostgREST's only |
| `recovery_absent` | True | No earlier repair is open |

`may_signal` false, or a `private` owned by anyone else, stops the release before the migration: recovery would rest on a
restart whose effect on PostgREST isn't documented. Support isn't contacted without the owner's approval.

## 2. The REST refusal test

**Target:** one synthetic show, never an existing record. `P.create()` calls `library_create_show_b45` with the title
`ZZ W1 Release Test`, key `zz w1 release test`, network `ZZ`, no TMDB id, one season, and stops if that key is already there. It
returns the show and season ids, which go in the private record before anything else.

**Field:** `tv_shows.priority`, a guarded column. **Original:** `normal`. **Attempted:** `high`.

**Request:** `PATCH tv_shows?id=eq.<show>&priority=eq.normal` with `{"priority":"high"}` and `Prefer: return=representation`,
eight at once, then a read of the value.

**Expected:** every answer `library_write_required`, and the value still `normal`. `P.direct` stops at anything else.

**If a write goes through:** `P.direct` calls `P.restore` at once: a `PATCH` filtered on `priority=eq.high` setting `normal`,
expecting one row, or the library function with the expected state if that's refused. It reads the value back and refuses to run
anything further on the page. The release then stops and is reported, whether or not the restore was confirmed. Nothing else is
written if it wasn't.

**Also, on the same record:**
- `P.noWrite()`: `library_cu_set_show_settings` with a random id answers `target_missing`, so the clause works through hosted
  PostgREST and no row can be touched.
- `P.legitimate()`: `library_set_show_state_b45` takes the priority to `low` and back, a real write through a library function.
- `P.signedOut('denied')`: a request with no sign-in is refused as usual.

**Cleanup:** `P.cleanup()` calls `delete_tv_season` with zero marks. It's the show's last season, so the show goes too, and both
are read back as gone. A leftover record is removed the same way from a fresh page, with `P.adopt(ids)`. The rehearsal shows
this leaves nothing behind in shows, seasons, findings, settings, removals, aliases, memberships, marks or the recovery archive.

A backup taken after the cleanup must equal the baseline field by field. That's the proof.

## 3. Release order

1. A fresh validated backup (the baseline). 2. Push, and open the PR without merging. 3. The hash-checked migration once, with a
fresh run id recorded first; the editor's text is replaced at once. An unclear answer is settled by reading the run record, never
by rerunning. 4. A separate read of the run record and the catalog, then `db/test/w1_catalog_check.sql`. 5. A post-migration
backup, validated and compared with the baseline. 6. Section 2, then a backup compared with the baseline. 7. Merge by merge
commit, then check Pages, the application files and the token.

## 4. The H2 drill

With the release verified and its record gone. Create a new record first (`P.create()`), and note the time. Each row needs its
proof before the next. A poll waits up to 60 seconds. `P` here is one page; after a reload, `P.adopt(ids)`.

| # | Run | Proof before moving on |
|---|---|---|
| 0 | `w1_recovery_status.sql`, then `P.shape()` | Nothing closed, no defaults. Note `oldest_postgrest_connection`, and the signed-out status and code |
| 1 | `w1_recovery_1_close.sql` | `P.peek()` answers `gate`: **access is blocked** |
| 2 | Checks | `P.signedOut('gate')`; `P.direct('denied')`; `P.noWrite('denied')`: the owner stops at schema access. The page's reads may fail here, which is expected |
| 3 | `w1_recovery_connections.sql` | `may_end` true, `ended` equals `found` |
| 4 | `w1_recovery_status.sql` | `oldest_postgrest_connection` is later than the `at` in step 3, or there are none: **connections are refreshed** |
| 5 | Checks | `P.signedOut('gate')`: the gate holds on new connections |
| 6 | `w1_recovery_2_replace.sql` | Runs: no default is visible. Nothing was poisoned, so there's nothing to remove |
| 7 | `w1_recovery_connections.sql`, then status | As steps 3 and 4 |
| 8 | Checks | `P.signedOut('gate')` |
| 9 | `w1_recovery_3_owner_only.sql` | Runs: schema access is back exactly |
| 10 | Checks, five rounds | `P.direct('guard')`: **direct writes are refused**. `P.noWrite()` and once `P.legitimate()`: **legitimate operations work**. `P.signedOut('gate')`: everyone else is still out |
| 11 | `w1_recovery_4_open.sql` | `P.peek()` answers `denied`, then `P.signedOut('denied', 40)`: the gate is off for everyone |
| 12 | `w1_recovery_5_clean.sql` | Runs |
| 13 | Status, then checks | Nothing closed, no gate, usage back. `P.direct('guard')`, `P.legitimate()`, `P.cleanup()` |
| 14 | The live page, reloaded | Views load, no console error |
| 15 | Backup | Equals the baseline field by field, with actual row counts and a distinct export time |

Only the signed-out request stands for "everyone else": no other account has a session. The gate treats any other caller the same,
and the local test proves that with a real second member.

## 5. Fallbacks

Nothing is poisoned, so a drill that can't finish goes back to normal by finishing: steps 9, 11 and 12, each with its proof. The
one exception is a refusal that fails.

| What happens | Do this | Then |
|---|---|---|
| Step 1 fails or is refused | Nothing changed (one transaction). Stop the drill | Report |
| Step 1 ran, the gate isn't seen in 60 s | `P.shape()` against step 0's answer: an unchanged PostgREST answer means the gate didn't load, a new one means the check can't read it. Then step 3 (connections), wait 60 s | Still no gate: one project restart, then check. Still none: the gate isn't proved on hosted. Run steps 9 and 11, then the connections script and its status proof, so PostgREST has read its configuration again, and only then step 12. If that proof fails, leave step 12 undone. Report |
| `may_end` false or `ended` short of `found` | One project restart in place of the connections script | `w1_recovery_status.sql` and the row's proof. Starting is not proof |
| A connection stays older than the script | Run it once more | Then one project restart |
| After step 1, `P.signedOut` answers anything but `gate` or `denied` | Stop the drill | Finish by steps 9, 11, 12 |
| Steps 9 or 12 refuse | Read the status and the error; run no other SQL | Report. The API stays as the last proof left it |
| Step 2: a direct write goes through | `P.restore` can't reach the row with schema access gone, so its answer is unconfirmed. Write nothing more. Run steps 9 and 11 for access only | Stop and report. The owner decides the restore |
| Step 10: a direct write goes through | `P.restore` has already run. Confirm the value. Turn Enable Data API off in the Dashboard, confirm requests fail | Stop and report, with the API closed |
| Step 10: any other unexpected answer | Stop. The gate stays on, the API closed for everyone but the owner | Report |
| Step 11: the gate is still on after 60 s | Connections script, 60 s | One project restart. Still on: report, and leave step 12 undone: dropping the function under a live gate fails every request |
| The page fails at step 14 | Status read; `P.signedOut('denied')`; one reload | Report |
| Data API off and needed back | Turn it on, and repeat the row's proof | |

At most one project restart. Its use is recorded, and a restart finishing proves nothing until the row's proof passes. Both gates
are stored in the database, so a restart doesn't open anything.

Never, in this drill: a poisoned setting, a change to any other role or setting, a restore, `db/test/w1_reverse.sql`, or a schema or
policy change. A failure outside these rows stops the drill for the owner's decision.

## 6. Limits of this proof

- The drill proves the gate, connection replacement, reconnection and reopening on the hosted project. It can't prove removal of a
  real default, or anything about a server-level default, which stays unconfirmed and would need Supabase Support.
- An ordinary second member isn't tested on hosted. A restart, if unused, stays unproved there.
- The hosted API path is tested with `priority` on one synthetic show. The rest of the guards are tested locally.

## 7. As run on production (2026-11-01)

The drill ran as written, with no fallback. Three things it taught, for any later run:

- The SQL Editor asks before step 1 (the RLS prompt, about `private.w1_recovery`: Run without RLS) and before step 5 (destructive
  operations: Run query). Neither has run until it's answered, so read each script's own result before moving on. "Success" on screen can be
  the previous run's. Step 5 needs the status read after it.
- PostgREST took 11 to 13 seconds to answer after its connections ended. Poll with `P.peek()`, which never stops the page, before
  `P.signedOut`, which does.
- The probe file can be loaded at an exact commit from the raw file, with its SHA-256 checked, instead of pasted.
