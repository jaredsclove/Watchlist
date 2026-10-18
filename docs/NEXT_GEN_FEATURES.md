# Watchlist next generation features

Ideas for selective future implementation. Listing an idea does not authorize implementation or establish a release commitment. Add new items with stable numbers; record decisions under each item as discussion continues. Keep current release state in STATE.md.

## 1 Episode progress within seasons

Added 2026-10-18. **Status: deferred exploration.** Revisit after S4–S6; no implementation approved. The initial discussion favored individual episode checkboxes with a bulk “mark through” action. Inline expansion was the selected mockup variant; the final interface and data rules remain open.

### User value and original proposal

Remember where viewing stopped, resume after a break, track several shows and distinguish an untouched season from one partly watched. Completing the finale could remove the need for a separate season-completion action. Its usefulness depends on quick updates; repeated navigation would add friction.

The original proposal was to add a season-level Currently Watching status, obtain episode counts from TMDB, provide progress checkboxes, expand season rows across views and automatically mark a season watched when every episode is watched.

### Proposed experience

Keep show-level Watching as the answer to “Am I following this show?” Derive season-level “In progress · 5/8 watched” from episode marks instead of introducing another independently maintained status. An explicit Start season action is only needed if a season should count as in progress before the first episode has been completed. Episode edits should not silently change the show's status.

- Collapsed show: next season/episode and compact progress, for example Season 3 · 5/8 watched.
- Expanded show: season rows with a watched control and progress count; a small progress bar is optional.
- Expanded season: episode numbers, optional titles and individual watched checkboxes.
- Bulk action: Mark through this episode, to record sequential viewing or initialize progress quickly.
- Collections: the same saved progress and controls as TV views.
- Coming Soon: retain its availability focus; episode editing need not be included initially.
- Specials: separate from normal seasons and excluded from ordinary-season completion.

Showly screenshots supplied the reference: its show overview displays season checkboxes, bars and counts such as 5/8 (62%); a separate season screen lists episode numbers, titles and checkboxes. They demonstrated a finished eight-episode season, not rules for incomplete metadata or ongoing releases. Watchlist could use inline expansion to preserve list context, or a dedicated season detail panel to reduce nested expansion on phones.

### Interactive mockup

Open [Episode progress mockup](mockups/episode-progress.html). It includes Inline expansion and Season detail alternatives, sample progress for The Mandalorian Season 3, individual checkboxes, Mark through and Mark all watched. The editable source is [episode-progress.fragment.html](mockups/episode-progress.fragment.html).

The mockup is a standalone concept using sample data, not an exact reproduction of Watchlist's styling or a connection to its database. It demonstrates completion for a fixed eight-episode list only. Seasons 1 and 2 are illustrative; Season 3 is interactive. In the mockup, clearing the Season 3 checkbox clears all its episode marks; that behavior is a proposal requiring a decision, not an approved product rule. Neither the mockup nor this record establishes implementation readiness.

### Feasibility and data approach

Feasible, but a substantive data-model feature rather than just new controls. Current season behavior uses watched/skipped flags, while Watching belongs to shows. Current Up next and Caught up calculations primarily operate at season level.

TMDB's [season-details endpoint](https://developer.themoviedb.org/reference/tv-season-details), addressed by series ID and season number, supplies episode metadata. Fetching a season's list avoids a separate request for every checkbox. The exact response contract and completion signals should be verified during implementation planning.

A candidate design associates saved progress with the local season and TMDB episode IDs, retaining episode numbers as metadata. Episode numbers alone are vulnerable to source numbering changes; external IDs still require careful handling when metadata is corrected. Separate durable user progress from refreshable episode metadata. Failed refreshes or disappearing source episodes must not erase watched history.

A small episode-progress store and cached episode metadata are plausible. Checkbox changes and resulting season-completion changes should be atomic. Reuse the existing write lane and uncertain-outcome reconciliation; do not add collaborative editing machinery for the one-active-user/device model.

### Completion and preservation rules to settle

- **Caught up versus complete:** watching all released episodes is not necessarily finishing a season. Four watched episodes out of ten should remain 4/10, even if only four have aired. Watching every episode currently listed also does not prove the source list is complete.
- **Automatic completion:** proposed only when all episodes in a sufficiently established finished list are watched. Define how that condition is established; episode count alone is insufficient. Retain explicit Mark season watched for ongoing or uncertain lists.
- **New metadata:** a refresh should not silently undo an explicit completion decision. Surface newly discovered episodes and decide how automatically derived completion responds.
- **Existing watched seasons:** preserve existing completion; do not fabricate historical episode marks or require backfilling. Decide how their episode panels represent unknown detail.
- **Season checkbox:** define bulk mark/unmark behavior and how it interacts with existing completion without detailed history. Avoid accidental loss of many marks.
- **Unchecking one episode:** proposed behavior is to reopen the season while retaining other marks, with the consequence made clear.
- **Skipping:** retain progress when a season is skipped.
- **Identity corrections:** rematching a season must not move progress onto unrelated episodes.
- **Unmatched seasons:** decide whether episode tracking requires a TMDB match initially or supports manual lists/counts.
- **Deletion and collections:** deleting a season must handle linked progress consistently; removing collection membership must retain progress.
- **Backup and restore:** include durable progress, support older backups and retain safety backups, identity-loss protection and field verification.
- **Views and interaction:** update Up next, Caught up and Currently Watching consistently; consider focus after updates and nested expansion on phones.

### Smallest useful scope and deferred extras

The current direction is individual episode checkboxes, a compact season count, bulk Mark through, a reusable expandable episode panel and conservative completion behavior. The alternative “watched through episode N” model is simpler if arbitrary episode selection proves unnecessary; this tradeoff remains available.

Leave rewatches, viewing dates, episode ratings, remaining runtime, percentages, plot summaries and automatic episode scheduling outside the initial scope. Episode titles may be optional for spoiler avoidance. Database/schema and backup-contract changes would require their own approved plan under the project rules. The existing production access-policy concern remains a separate matter.

### When revisiting

First settle the everyday interaction and completion rules, then ask Claude for a short implementation proposal against the current code. Assess maintenance cost and reliable saved-data behavior rather than optimizing line or test counts. This item is not part of S4–S6 or automatic Batch B scope.

## 2 Ratings for shows seasons and episodes

Added 2026-10-18. **Status: deferred exploration.** No provider selected or implementation approved. The aim is to bring external ratings into Watchlist at show and season level, potentially extending to episodes as in the Showly reference. Rotten Tomatoes critic and audience scores are of particular interest.

### User value and scope

Help choose what to watch, compare seasons and see differences between critic and audience reception without leaving Watchlist. Show and season ratings can be implemented independently of item 1. Episode ratings could later share its expanded episode interface and metadata request. Ratings should remain secondary to viewing progress and controls.

Two possible scopes emerged: a modest TMDB-only feature, or a broader multi-source feature. If critic-versus-audience comparison is the main value, prove access to that data before choosing TMDB solely for convenience.

### Provider options and feasibility

The following reflects documentation research on 2026-10-18, not authenticated API sampling or confirmed coverage of the user's library. Recheck contracts, limits and terms when selecting a provider.

| Provider | Coverage and access | Difficulty and fit |
|---|---|---|
| TMDB | Community show scores; season vote_average; episode vote_average and vote_count in a season-details response. A season-level vote count was not documented in that response. | Lowest difficulty because Watchlist already uses TMDB identities and requests. These are TMDB scores, not IMDb or Rotten Tomatoes scores. |
| Trakt | Documented community ratings for shows, seasons and episodes, including a dedicated season-rating endpoint. | Feasible additional provider, but its own community ratings do not provide the critic/audience distinction. |
| IMDb directly | Noncommercial daily datasets include title ratings and episode-to-series relationships. No independent season score was established in those datasets. | More infrastructure: download, filter and publish relevant data. An average of episode scores would be Watchlist-calculated, not an official IMDb season rating. |
| OMDb | Series and episode lookups, including episodes returned by season. | Possible simpler IMDb route. Season lookup does not establish a separate season rating; reliable Rotten Tomatoes season critic/audience coverage remains unverified. |
| Rotten Tomatoes directly | Show and season critic/audience scores; episode critic Tomatometers exist subject to review thresholds. Episode audience coverage was not established. Integration access is by business proposal. | Technically possible, but suitable access, pricing and permitted use are unconfirmed. No verified self-service developer route for this project. |
| MDBList | Aggregated ratings are a candidate route to multiple sources. Exact external-rating coverage at show, season and episode levels remains unverified. | Worth investigating for Rotten Tomatoes. Documented free quota was 1,000 requests/day; verify current limits and coverage before relying on it. |

TMDB is the simplest initial option, provided its community scores are useful to the owner. Its noncommercial API requires attribution. Rotten Tomatoes direct integration is uncertain rather than impossible; scraping its pages would introduce recurring fragility, matching problems and usage-permission questions, and is not the recommended approach.

### Proposed interface and implementation

- Show row or Details: compact source-labelled score, for example TMDB 8.2/10.
- Season row: the season's own score; never silently substitute a show score.
- Expanded episodes: optional small episode scores beside titles or numbers.
- Rotten Tomatoes, if available: separate Critics 92% and Audience 84% labels.
- Score details: source link, vote/review count where available and refresh date.

Fetch on demand and cache results. Refresh current releases more often than older completed shows. Failed or missing ratings must not block ordinary Watchlist controls, change viewing status or affect saved progress.

A first TMDB version could use a browser cache and avoid database or backup changes: external scores are replaceable reference data. A shared/server-side cache becomes more useful with paid credentials, cross-device consistency or library-wide sorting. A public static page cannot conceal a secret provider key; a provider requiring secrecy may need a small server-side proxy.

For episode ratings, reuse the TMDB season-details request rather than fetching each score separately. Keep this work independent of episode-progress storage and its safeguards.

### Risks and decisions

- **Meaning:** Rotten Tomatoes positive-review percentages and average scores out of ten measure different things. Preserve native scales and source labels; do not imply a universal combined score.
- **Small samples:** high scores with few votes can mislead. Display counts where available and distinguish missing scores from zero. Decide whether to suppress or flag very low-count scores.
- **Season semantics:** provider scores may use different aggregation rules. Rotten Tomatoes describes its series Tomatometer as an aggregation of qualifying seasons, and season scores can include episodic scores. Do not present a locally calculated episode average as a provider's season rating.
- **Coverage:** not every show, season or episode has ratings. Establish whether the preferred providers cover representative titles before choosing the integration.
- **Matching:** use external IDs where possible; handle remakes, specials, split seasons and numbering disagreements without guessing.
- **Freshness:** make cached age understandable and avoid unnecessary repeated refreshes. New releases can change quickly.
- **Access and maintenance:** verify permitted use, attribution, key handling, quotas and recurring cost. An intermediary adds its own availability and upstream-dependency risks.
- **Interface:** avoid crowding progress controls. Optional episode scores can reduce expectation bias or unwanted hints about upcoming episodes.
- **Sorting:** on-demand display is simpler than rating-based sorting/filtering across the entire library, which requires more complete and consistently refreshed coverage. Defer sorting unless useful enough to justify that scope.

### When revisiting

Decide whether any useful community score is sufficient or whether critic/audience comparison is the essential requirement. For the former, plan a small TMDB display-and-cache feature. For the latter, first verify an authorized Rotten Tomatoes or intermediary access path, including actual season-level critic and audience fields, representative coverage and terms. No production access is needed merely to assess public documentation; any credential use or production work remains separately scoped.

### Sources

- [TMDB show details](https://developer.themoviedb.org/reference/tv-series-details)
- [TMDB season details](https://developer.themoviedb.org/reference/tv-season-details)
- [TMDB API FAQ and attribution](https://developer.themoviedb.org/docs/faq)
- [Trakt API](https://trakt.docs.apiary.io/)
- [IMDb noncommercial datasets](https://data.imdb.com/non-commercial-datasets/)
- [OMDb API](https://www.omdbapi.com/)
- [Rotten Tomatoes FAQ and television score methodology](https://www.rottentomatoes.com/faq)
- [Rotten Tomatoes licensing](https://www.rottentomatoes.com/help_desk/licensing)
- [MDBList API access and limits](https://docs.mdblist.com/docs/api)

## 3 Multiple users with isolated personal libraries

Added and clarified 2026-10-18. **Status: deferred exploration.** Each person must have a cleanly separated private library, with protection against cross-access and accidental mixing. Physically separate databases are not required. Prefer one shared Supabase project, subject to an ownership and authorization review. A paid plan is acceptable if useful. Sign-in should persist across ordinary app visits. No implementation, subscription purchase, provisioning or production investigation is authorized by this entry.

### Feasibility and architectural direction

Use one application, one Supabase project and one authentication system. Personal records share tables but belong to individual users through user_id. Supabase Auth identifies the caller; database Row Level Security (RLS), grants, constraints and function checks enforce which records that caller may read or change. Interface filtering alone is insufficient.

The recorded schema already includes owner-scoped rows, which is a useful foundation, but having user_id columns does not establish complete isolation. Review current owner resolution, fixed-owner assumptions, database functions, views and relationships before designing the migration.

This refines the earlier physical-database assumption: the intended unit of independence is now the personal library. Each person edits their own records; shared-library collaborative editing remains outside scope. The one-active-device assumption can apply per user/library rather than per physical database. Independent users may use the application concurrently without sharing editable records, provided functions and constraints are correctly owner-scoped.

Login should lead directly to the authenticated person's library at the same application URL. No project picker or cross-project identity directory is needed. For the initial family scope, prefer invitation-only onboarding or equivalent server-enforced admission. App users do not need Supabase dashboard access.

Separate projects remain an alternative if independent administration, project-level recovery or stronger operational separation becomes important. They add per-project costs and repeated configuration/migrations and are not the preferred starting point.

### Supabase cost

With one project, adding users does not incur a separate project charge per person. Storage, authentication, bandwidth and other usage accumulate within the project's and organization's applicable quotas. Free may suffice for a small family; paid service is not inherently required for multiple users or remembered sessions.

Public documentation checked 2026-10-18: Free permits two active projects across organizations where the account is an owner/administrator. Pro has a $25/month organization base and a $10 compute credit, which approximately covers one continuously active Micro project. Usage overages, taxes, larger compute and add-ons can increase the cost. Pro projects do not pause for inactivity. A separately hosted staging project incurs additional compute; local development remains an option. Recheck pricing and operational needs before choosing a plan. The previously discussed per-person project estimates apply only to the separate-project alternative.

### Login and identification

Proposed everyday experience: open Watchlist, restore the saved session, and see the correct personal library. On first use or a new browser/device, authenticate once. Supabase's JavaScript client supports persisted sessions and token refresh; Supabase documents no default fixed maximum session lifetime. Ordinary visits need not require signing in again. Sign-out, revoked sessions, cleared storage, private browsing or recovery events can require another login; never promise permanent login.

Choose one initial authentication method:

- Google sign-in if all intended users are comfortable using Google, with provider and redirect configuration for the application.
- Email one-time code or magic link if avoiding a social-login dependency is preferable. Configure reliable email delivery; Supabase's default mail service has restrictions and is not a general production delivery solution. Codes may avoid links opening in the wrong browser context.
- Email/password is possible but introduces password recovery and another credential to manage.

Use the authenticated user's stable ID for authorization. An email/name in local storage, a dropdown selection or a private-looking URL is not proof of identity. Let the supported Auth client manage tokens rather than inventing a custom long-lived secret. Keep service-role keys and database passwords out of the public app.

### Isolation and saved-data protections

Database policies must enforce ownership for reads, inserts, updates and deletes, including attempts to forge an owner ID or address another user's known record ID. Review every exposed path, especially privileged database functions and views that may bypass ordinary RLS checks. Resolve ownership from the authenticated caller rather than trusting a supplied user ID.

Relationships must not link one user's season, show or collection to another user's records. Check owner scoping of uniqueness rules as well: two people must be able to track the same TMDB title independently without collisions. Public catalog definitions or replaceable metadata may be shared where appropriate; personal membership, progress and choices remain private.

Verification should use at least two distinct authenticated identities plus signed-out access, testing both allowed and denied operations. Include collection relationships, deletes and restore, and prove that restoring one user's library leaves the other's unchanged. These are meaningful isolation checks, not evidence supplied by a login screen alone.

The previously recorded production access-policy concern remains unverified. Recording this feature does not authorize its investigation; a separately authorized policy/contract review is necessary before rollout. Authentication must be paired with appropriate policies and grants; adding a login screen alone does not remove anonymous access.

Preserve existing saved data when associating the current library with its authenticated owner. Validate migrations offline first; changes to schema, policies, contracts and production remain subject to existing approval rules. Preserve uncertain-outcome handling and restore protection.

### Operational and user-experience considerations

- **Updates and shared operations:** one database migration serves all users, reducing maintenance. A project outage or privileged administrative mistake can affect everyone; logical isolation does not isolate infrastructure failures or administrators.
- **New libraries:** create personal starting state without copying another person's viewing history, collections or preferences. Decide whether optional starter content is useful.
- **Backup and restore:** app exports and restores must operate only on the authenticated owner's records, with existing safety backups and verification retained. Existing portable backups omit user_id; define destination confirmation and intentional imports explicitly. Whole-project recovery affects all users and is distinct from personal-library restore.
- **Account changes:** show the active account, clear previous library data from memory and namespace personal caches/preferences by user. Prevent stale reads from repopulating the old library after account changes. Do not switch identities during in-flight writes or unresolved outcomes; a full reload on explicit account switching may be simpler.
- **Session loss:** stop new writes and offer reauthentication; never fall back to anonymous writes or blindly retry an uncertain mutation after login.
- **Devices:** remembered login on several devices does not establish support for simultaneous editing of one person's library. Keep one active device per user unless this requirement changes explicitly.
- **Administration:** decide who pays, handles account recovery and offboarding, monitors backups and exports a library if someone later wants independent ownership. The project administrator retains privileged access.
- **Shared devices:** provide sign-out and make the active account visible. Remembered sessions assume the device user accepts that access.

### Smallest useful scope and next decision

For a few known users, prefer one shared project, one application release and URL, invitation-only accounts, one login method and remembered sessions. Defer public signup, shared-library editing and separate-project routing.

When revisiting, establish expected user count and preferred login method. Ask Claude for a concise proposal covering current owner/function assumptions, RLS and grants, cross-owner relationships, migration of the original library, personal restore and account-switch behavior. The feature is architecturally plausible; completeness of the existing ownership protections remains to be established.

### Sources

- [Supabase billing FAQ](https://supabase.com/docs/guides/platform/billing-faq)
- [Supabase billing and free-project limits](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Supabase user sessions](https://supabase.com/docs/guides/auth/sessions)
- [JavaScript Auth persistence](https://supabase.com/docs/reference/javascript/auth)
- [Google sign-in](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Passwordless email sign-in](https://supabase.com/docs/guides/auth/auth-email-passwordless)
- [Custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Database functions and execution privileges](https://supabase.com/docs/guides/database/functions)
