# Item 4: collection updates — database and backup design (CU1)

Design for owner approval before any `db/` or backup-format change. Library titles never appear in this
repository: the built-in definitions, exclusions and holds reach the app as a local setup file (section 7).

## 1. Migration and phase

- One transaction, `db/cu1_collection_updates.sql`, run like EP1: preamble `watchlist.cu1_run`, run label,
  every lock, preconditions (phase `contracted-ep1`, `access = members`, run id unused), before-state
  fingerprints of every existing table, then the changes, grants, verification before commit and the run
  record in `private.migration_runs`. No rollback (fix-forward); a test-only reverse script for rehearsals.
- `stage5_capabilities()` becomes phase `contracted-cu1`, `backup_format` 7, `cu1` 1. The new page writes only
  in that phase. An open older page fails closed (its phase check stops writes, backups and restores) until
  it is reloaded; that is the existing behaviour on every phase change.
- No existing table, column, constraint or row changes. Every existing row's fingerprint is verified unchanged.

## 2. New tables (all owner-only)

Every table: `user_id` defaulting to `private.current_owner_id()` (FK `auth.users`, restrict); M1's policies
(owner select / insert / update / delete plus the restrictive `members_only`); nothing for `anon`; composite
foreign keys `(x_id, user_id)` so a row can only point at the same owner's rows; the existing
`private.library_write_guard` trigger on insert, update and delete, so rows change only inside the library
functions below or restore. Grants are explicit and verified, as in EP1.

| Table | Purpose | Key columns and constraints |
|---|---|---|
| `update_setup` | One row per owner: whether the holds and definitions for catalog-governed records are in place (section 3.2) | `user_id` primary key; `setup_confirmed_at`; `source` = setup_file |
| `collection_definitions` | Versioned definitions, one row per confirmed version; rows never change | `collection_id` → `personal_collections` (cascade); `version` > 0, unique per collection; `mode` ∈ manual / follow / discover; `rules` (validated JSON list, below); `evidence` (official domains, trade outlets with their domains, standard `official_or_two_trades`); `summary`; `confirmed_at`; computed by the database on insert: `rule_hashes` (per rule, over its eligibility fields only) and `evidence_hash` |
| `collection_exclusions` | Current exclusions (not versioned; always applied as they stand) | `collection_id` (cascade); `kind` ∈ title / every_version / series_and_spinoffs; `title`, normalized `match_text`, optional `tmdb_id`, `media`; unique (collection, kind, match_text) |
| `update_holds` | Standing decisions, protected values, identity holds | `kind`; optional `collection_id`, `show_id`, `item_id` (cascade) and `subject_label` (a season label or a title not yet in the library); for protected values `field` ∈ display_date / title / season_label and `protected_value`; `decision`, `effect`, `reopen` (typed condition), `decided_on`. Identity holds need a show or item |
| `record_aliases` | Evidenced alternative titles | exactly one of `show_id` / `item_id` (cascade); `alias`, `match_text`, `evidence` (links); unique per record and `match_text`. Never changes a title |
| `membership_removals` | Remembered removals from a collection | `collection_id` (cascade), exactly one of `show_id` / `item_id` (cascade), `removed_at`; unique per collection and record |
| `show_update_settings` | Per-show update settings | `show_id` primary key (cascade); `follow_when_skipped`; `new_season_after_ended_at` (the flag; cleared by the owner) |
| `update_findings` | Findings from TMDB checks and imports, their decisions and results | unique (owner, `fingerprint`); `source` ∈ tmdb / research; `kind`; `status` ∈ pending / needs_evidence / conflict / needs_research / set_aside / not_now / excluded / accepted / applied / dismissed; `reason` (why it is in that status); `collection_id` (cascade); `show_id`, `item_id`, `season_id` (`on delete set null` on the id column only); `subject`, `proposed`, `expected`, `evidence`, `assessment` (JSON); `rule_id`, `definition_version`, `rule_hash` and `evidence_hash` it was researched under, `brief_id`; first / last seen; `decided_at`, `applied_at`, `result` (what the application did) |
| `research_briefs` | Exported briefs | `id` (the brief id), `exported_at`, the collections and definition versions it carried |
| `research_imports` | Imported findings files | `brief_id` → `research_briefs` (cascade); `file_sha256` unique per owner; `imported_at`; counts |

`rules` is validated by `private.cu1_rules_ok`: a list of `{id, type, …}` with `type` ∈ franchise /
platform_premiere / person_role / explicit_list / written and only that type's fields (TMDB ids as integers,
roles from fixed lists, a premiere region as a two-letter code, text lengths capped).

## 3. Guarded operations

All `security invoker`, owner-scoped, refusing with stable codes (`target_changed`, `held`, `show_skipped`, …)
and changing nothing on refusal. Each takes the expected values the page showed.

- **Definitions and rules:** `library_cu_save_definition` (new version only when the expected current version
  matches), `library_cu_set_exclusion`, `library_cu_save_hold` / `library_cu_delete_hold`,
  `library_cu_set_show_settings` (follow while skipped; clear the Ended flag), `library_cu_import_setup` (the
  setup file in one transaction; refused for a collection that already has a definition).
- **Findings:** `library_cu_register_brief`; `library_cu_record_findings` (one import: inserts new
  fingerprints, merges evidence into existing ones, records the file hash, refuses a file already imported;
  status changes only as in section 3.3); `library_cu_set_finding_status` (owner decisions: Not now, Exclude,
  Dismiss; allowed transitions only).
- **Seasons — `library_cu_reconcile_season(show, expected, season, basis)`.** Locks the show and all its season
  rows, then decides on the stored rows, not the page's view:
  1. refuses a Skipped show unless `follow_when_skipped`, and a season a standing decision says not to add;
  2. an identified row for that TMDB season → `existing` (nothing written);
  3. exactly one unidentified row labelled exactly `Season N`, no identified row for N → that row is reused:
     with TMDB basis on a TMDB-matched show and no identity hold, its `tmdb_id` and `season_number` are set
     (`mapped`); otherwise `existing`;
  4. any other row whose label names N (Part, Volume, Final, Specials, a second candidate) or the TMDB season
     already on another row → `review` (nothing written);
  5. otherwise created: with TMDB basis as an identified season (through the existing `lib_add_to_show` checks);
     with announcement basis as an unidentified `Season N` (`TBA` unless a date is given). The theme is the
     show's own (from its latest season). An Ended show keeps Ended and gets `new_season_after_ended_at`.
  Status, priority, Ended, markers, titles, labels, memberships and marks are never changed.
- **Identity — `library_cu_attach_identity(show, expected, tmdb_id, listed_season_numbers, basis)`.** Refuses an
  identity hold, a TMDB id another show has and a show already matched; without an owner review decision it
  also refuses a TMDB title that isn't the show's title or an evidenced alias, and any season label that isn't a
  plain `Season N` (with review, those rows stay unidentified). Sets the show's `tmdb_id` (title and key
  unchanged) and maps each plain `Season N` that TMDB lists, that no other row holds and that no identity hold
  names; the rest stay unidentified (awaiting TMDB). A season the review screen maps after an ambiguous
  correspondence goes through `library_cu_reconcile_season` with the owner's chosen row, under the same rules
  (an identity hold on that row's own label refuses it). Unidentified seasons have no marks, and EP1's identity
  guard still protects every marked season.
- **Dates — `library_cu_set_season_date(row, expected, new, basis)`.** The only new path that sets
  `watchlist.catalog_date_write`, and only inside its own call. Allowed: a stored date containing `TBA` → an exact
  date; a future exact date → another future exact date, with TMDB or evidence basis; any other change only with
  basis `review` naming a pending finding for that row (which becomes applied). Refused: a row with a protected
  date hold (except through review), an aired date without review, a stale expected value. The
  `catalog_date_guard` trigger is unchanged, so every other path stays refused.
- **Aliases — `library_cu_add_alias`.** Adds an alias with its evidence; never changes a title.
- **Accepting — `library_cu_accept_finding(finding, expected_status, choice)`.** In one transaction: either
  creates the show (with its seasons, unidentified or TMDB) or film using the existing create functions'
  checks — a same-named record a catalog governs is passed as `distinct_from` only when the owner chose
  "Different work" — or, for "Same as", uses the existing record; then adds the membership and marks the finding
  accepted. A recorded removal from that collection is refused unless the owner explicitly chose to add it back.
- **Memberships:** `org_remove_membership` (same signature) also records the removal; `org_add_membership`
  (same signature) clears it. Older pages keep working with them.
- **Retirement:** `library_catalog_apply_b45` and `library_catalog_apply` become `client_outdated` refusals.
  Governance links, `catalog_id`, the date guard and the duplicate-name rule stay.

### 3.1 Where each rule is enforced

The page and the database each have a defined part; the database re-reads everything it checks under lock at
the moment of the write, so a caller-supplied `basis` or an old brief can't stand in for current state.

| Rule | Page (before calling) | Database (inside every applying function) |
|---|---|---|
| What an article says, whether it is current, whether reports are independent | Relies on Claude's recorded assessment; shows it as such | Not checked (content) |
| Evidence structure: an official source on the collection's official domains; two different listed trade outlets, neither credited to the other; publication dates no later than the research date and, for a reopened decision, after the decision; no recorded conflict; `standard` not insufficient | Checks it to route findings | **Checked again** from the finding row and the current definition's evidence settings (`private.cu1_evidence_ok`). Research-based writes require it; no basis skips it |
| Collection mode and definition (collection-research findings only) | Routes findings | **Checked** for findings with source `research`: the finding's collection has a current definition; the mode isn't Manual (Discover for new titles); the finding's `rule_hash` and `evidence_hash` equal the current version's. A changed hash means a relevant change: `needs_research` (status set, nothing applied). Not applied to TMDB-basis findings: library-wide Refresh shows covers Manual collections and shows in no collection |
| Exclusions | Routes findings | **Checked** against the current exclusions (title, aliases, every-version phrase, series-and-spin-offs root) |
| Holds and protected values | Routes findings | **Checked** in every function. Identity holds can't be overridden by any basis; protected values and aired dates only by an owner review decision naming that finding |
| Skipped / follow while skipped / Ended | Routes findings | **Checked** (Skipped refused unless following; Ended kept and flagged) |
| Expected current values | Sends what it showed | **Checked**; a difference refuses (`target_changed`) and changes nothing |
| Season correspondence, TMDB id uniqueness | Proposes | **Decided by the database** from the stored rows (section 3) |
| TMDB facts (a season is listed, its date, its episode count) | Fetched from TMDB and sent with basis `tmdb` | Taken as sent, as Refresh shows does today; a TMDB-basis season with no date and no episodes is refused (it needs announcement evidence) |
| Owner intent for a review decision | Only an owner's click sends basis `review` | Requires a finding in `pending` for exactly that record and value; records the decision. The database can't tell a click from automation; the page sends `review` only from the review screen |

### 3.2 Missing setup and holds

- `update_setup` gates automatic updates to **catalog-governed records** (shows and films with a governance
  link), the only records the imported holds and definitions describe. Until the owner has a setup row,
  every applying function refuses basis `tmdb` or `research` for such a record with `setup_required` (the
  finding is kept as pending, reason "waiting for collection setup"); research imports are refused for
  collections without a confirmed definition.
- The row appears when the setup file is imported (`source` setup_file). An owner with no catalog-governed
  records needs none: the gate applies only to catalog-governed records. It is part of backup format 7.
- After the migration, and after restoring a format 3–6 backup, there is no row, so the gate is on. Settings,
  Refresh shows' results and the review screen say "Automatic updates for catalog shows are paused until the
  collection setup is imported", with the import button. Importing the setup file (or restoring a format-7
  backup that has the row) restores eligibility.
- Not gated: Refresh shows for every other show (automatic, as agreed), review decisions the owner makes,
  and all existing functions (Add season, Match, marks, statuses, collections, backup).

### 3.3 Findings and application are one transaction

A TMDB finding that a policy outcome parked (`needs_evidence`, `set_aside`) and the owner hasn't decided is
checked again the next time Refresh shows sends it, with what TMDB says then (a date and episodes listed later, a
Skipped show now followed). Every standing decision that applies to a record is consulted; the most restrictive
outcome wins.

- Every automatic change (season, mapping, identity, date, alias) and every acceptance goes through a
  function that takes the finding (for TMDB checks the page sends the finding's fingerprint and content; the
  function inserts or updates it). The library change and the finding's new status, `applied_at` and `result`
  commit together, or neither does.
- **Applied:** the change and `applied`. **No-op** (the season already exists, the date is already that value,
  the alias exists): no library change, finding `applied` with result `already`. **Policy outcome** (held,
  excluded, Skipped, setup required, relevant definition change, evidence below standard, ambiguous
  correspondence): no library change; the finding's status and reason are set in the same transaction
  (`set_aside`, `needs_research`, `needs_evidence`, or `pending` for review). **Stale or invalid request**
  (`target_changed`, malformed): raised; nothing changes, the finding included; the next check re-reads.
- **No answer:** the page sends nothing more (as today) and says the outcome is unknown. The next check reads the
  finding: `applied` means it committed; otherwise it is evaluated again against the current library, and the
  season, date and alias rules are state-based (an existing row is a no-op, a date needs its expected value), so
  a repeat can't duplicate or report a change twice.
- **Status transitions on import** (`library_cu_record_findings`): a new fingerprint starts `pending` (or the
  routed status). An unchanged re-import only updates `last_seen_at`. `needs_evidence`, `conflict` and
  `needs_research` return to `pending` only when the import adds evidence (a URL not already held) that passes
  the structural check, or comes from a brief exported under the current hashes. **Not now** returns to
  `pending` only when the import adds evidence published after `decided_at` that passes the structural check;
  the same evidence again keeps it quiet. `set_aside` returns only from a brief exported after it was set aside.
  **Excluded** never returns (its exclusion row also stops it at application); `accepted`, `applied` and
  `dismissed` are final.

## 4. Preservation

Reconciliation and identity attachment only ever set `tmdb_id` / `season_number` on unidentified rows, or insert
new rows. Nothing deletes a row, changes a title, label, status, priority, Ended, marker, membership or mark.
Each function verifies before returning that the show's status, priority and Ended are unchanged.

### 4.1 Deleting seasons (owner-approved)

- **Catalog-governed entries are skip-only.** Every season and film of a catalog-governed record, including a
  season the owner added by hand, offers Skip instead of Delete: it is marked Skipped and stays in the library, so
  the collection's history and later research still see it. This is the existing catalog-entry rule, extended to
  every governed row.
- **Other TMDB-matched shows.** Deleting a season removes it, but Refresh shows reconciles each matched show
  against TMDB's season list and adds any listed season the library lacks. While TMDB still lists the deleted
  season, the next Refresh shows adds it again (a new unwatched, unskipped season row, without the deleted row's episode marks). Skip
  keeps the season in the library without it counting as something to watch, and Refresh leaves it as it is. The
  delete dialog says this for a matched season that isn't the show's last; deleting the last season deletes the
  show, which Refresh then no longer checks. An unmatched season isn't re-added.

### 4.2 Page-side reads and reports (validation pass)

- **Episode lists.** Refresh shows reads TMDB's documented season details (`/tv/{id}/season/{n}`), one request per
  season, only for a stored season not watched or skipped whose cached list doesn't match the episode count in the
  show details; other seasons keep that count. It doesn't rely on appending seasons to the show request, which the
  TMDB documentation doesn't describe.
- **Import coverage.** The import rebuilds the checks the brief asked for (records and memberships that existed at
  export, with the brief's rules) and lists any the file's coverage doesn't report, alongside failed and
  unsupported checks; the summary gives the reported and completed counts and how many findings were already
  applied or decided (left as they are).

## 5. Backup format 7

- Tables: format 6's nine plus the ten above (nineteen), no `user_id`.
- `restore_backup` for format 7: the format-6 function is kept unchanged as `private.restore_backup_v6` and
  restores format 6's nine tables; the owner's rows in CU1's ten new tables are deleted first (or go by cascade), then
  inserted from the file and verified row for row, in the same transaction.
- Formats 3, 4, 5 and 6 are converted in the page (6 → 7 adds the ten tables empty). The preview states what
  a restore of such a file removes: the current definitions, exclusions, holds, aliases, removals, settings,
  findings and the setup row, by count, and that automatic updates for catalog shows pause until the setup file
  is imported again (section 3.2).
- A format-7 backup taken by the new page is the safety backup before every restore, as today.

## 6. Retirement compatibility

The catalog lists in `config.js`, `catalog-apply.js` and Settings' "Review catalog updates…" are removed in the
same release. Theme and year filters that read the lists derive their values from the library instead. Every
existing record, membership, curated value, "New from catalog" marker and governance link is kept.

## 7. The built-in definitions without titles in the repository

The three definitions, seven exclusions and the holds are written into a local setup file
(`watchlist-collection-setup`, version 1) outside the repository, from the skill's text. Settings → Collections →
Import setup previews every item (records resolved by title and key, ambiguities offered as choices) and imports
only after confirmation, through `library_cu_import_setup`.

## 8. Rehearsal and review

Local PGlite rehearsal (`tools/db-rehearsal-cu1.mjs`) on a synthetic library: migration, refused replay,
self-checks (`db/test/t_cu1.sql`), every guarded operation, format-7 backup and restore, conversion from 6, and
the reverse script. Selective Fable review covers the migration, restore and the reconciliation, identity and
date functions together.
