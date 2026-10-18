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

## 3 Multiple users with a separate database for each

Added 2026-10-18. **Status: deferred exploration.** Owner requirement: each person has their own database; a paid Supabase plan is acceptable if needed. Sign-in should persist across ordinary app visits. No implementation, subscription purchase, project provisioning or production investigation is authorized by this entry.

### Feasibility and architectural direction

This follows the established model of one owner and one active user/device per database. Separate personal libraries do not require shared-database collaboration or a return to complex cross-user concurrency machinery. The design intent supports feasibility, but does not establish that current authentication, owner resolution, database functions and policies are ready without changes.

The simplest candidate for a small family is one Supabase project per person, under one centrally managed organization, with one maintained Watchlist codebase. Each project provides its own database and Auth service. Do not fork application logic per person. Use a small configuration layer or separately configured deployments of the same release.

A personal bookmarked entry URL or first-use library selection identifies the destination project before authentication. That selection only routes requests; it grants no access. Authenticate using that project's Supabase Auth, then require the authenticated identity to be the approved owner. A user-created account in a project must not automatically gain its owner's data. Keep onboarding invitation-only or otherwise server-enforced. App users do not need Supabase dashboard access.

A single universal login that discovers and routes a user to their database is another possible design, but adds a trusted identity-to-project directory and cross-project authentication design. A session from one Supabase project cannot simply be assumed valid in another. Do not introduce central authentication/proxy infrastructure unless the benefit outweighs the extra maintenance for a handful of users.

### Supabase cost and project limits

Public documentation checked 2026-10-18: Free permits two active projects across organizations where the account is an owner/administrator. Thus payment is not inherently required for two small personal databases if both slots are available; existing production or hosted test projects consume slots. Free-project pausing and capacity limits also affect suitability.

Pro is billed per organization, with dedicated compute charged per project and one $10/month compute credit per paid organization. At the documented $25 base and approximately $10/month Micro compute per continuously active project, indicative totals are $25 for one project, $35 for two, $45 for three and $55 for four. These are base estimates before taxes, usage overages, larger compute and add-ons; recheck pricing before choosing. Pro does not include unlimited separately hosted databases for $25. Projects in a Pro organization do not pause for inactivity. Additional hosted staging projects add cost; local development remains an option.

### Login and identification

Proposed everyday experience: open a personal bookmark, restore the saved session, and use the app. On first use or a new browser/device, authenticate once. Supabase's JavaScript client supports persisted sessions and token refresh; Supabase documents no default fixed maximum session lifetime. Ordinary visits need not require signing in again, and this convenience does not itself require Pro. Sign-out, revoked sessions, cleared storage, private browsing or recovery events can require another login; never promise permanent login.

Choose one initial authentication method:

- Google sign-in if all intended users are comfortable using Google; configure redirects and provider settings for each project.
- Email one-time code or magic link if avoiding a shared social-login provider is preferable. Configure reliable email delivery; Supabase's default mail service has restrictions and is not a general production delivery solution. Codes may avoid links opening in the wrong browser context.
- Email/password is possible but introduces password recovery and another credential to manage.

Use the authenticated user's stable ID for authorization. An email/name in local storage, a dropdown selection or a private-looking URL is not proof of identity. Save only project routing preferences as convenience state. Let the supported Auth client manage tokens rather than inventing a custom long-lived secret. Keep service-role keys and database passwords out of the public app.

### Security and saved-data implications

Separate databases limit cross-user mixing but do not secure an anonymously accessible database. Authentication must be paired with appropriate table policies, grants and database-function authorization, including privileged functions, backups and restore. Every read/write path must resolve the intended authenticated owner and fail closed if the session or project is wrong. Audit existing fixed-owner or anonymous-role assumptions before planning migration.

The previously recorded production access-policy concern remains unverified. Recording this feature does not authorize its investigation; a separately authorized policy/contract review is necessary before rollout. Adding a login screen alone does not resolve anonymous access.

Preserve existing saved data when associating the original database with its authenticated owner. Validate migrations offline first; changes to schema, policies, contracts and production remain subject to the existing approval rules. Preserve uncertain-outcome handling and restore protection.

### Operational and user-experience considerations

- **One release, several databases:** maintain reproducible provisioning and versioned migrations. Track each project's schema/capability version so one app release cannot assume an upgrade succeeded everywhere.
- **New libraries:** initialize schema and public catalog definitions without copying another person's viewing history, personal collections or preferences. Decide whether optional starter content is useful.
- **Backups and restore:** identify the selected destination clearly. Guard against restoring one person's backup into another database. Existing portable backups omit user_id; decide how destination confirmation and intentional cross-database imports work without weakening restore safeguards.
- **Account changes:** clear old library data from memory and namespace caches/preferences by project and user. Do not switch destinations during an in-flight write or uncertain outcome. A full app reload on an explicit library switch may be simpler.
- **Session loss:** stop new writes and offer reauthentication; never fall back to anonymous writes or blindly retry an uncertain mutation after login.
- **Devices:** persistent login on several devices does not imply simultaneous editing is supported. Retain one active device per personal database unless changing that requirement explicitly.
- **Administration:** decide who owns/pays for projects, handles recovery and offboarding, monitors backups and migrates a library if someone later wants independent ownership. Central administration is convenient but gives the administrator access; physical separation does not remove that relationship.
- **Shared devices:** show the active library/account and provide sign-out. Remembered sessions are appropriate only where the device user accepts that access.

### Smallest useful scope and next decision

For a few known users, prefer manually provisioned personal projects, one common application release, a personal entry link, one login method and remembered sessions. Defer public signup, automated provisioning, universal cross-project login and shared editing.

When revisiting, establish expected user count, hosted development needs and preferred login method. Then ask Claude for a concise proposal covering configuration selection, current owner/function assumptions, isolation, migration and recovery. The feature is architecturally plausible, with most new work in authentication, authorization and repeatable operation of several projects.

### Sources

- [Supabase billing FAQ and multi-project cost example](https://supabase.com/docs/guides/platform/billing-faq)
- [Supabase billing and free-project limits](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Supabase user sessions](https://supabase.com/docs/guides/auth/sessions)
- [JavaScript Auth persistence](https://supabase.com/docs/reference/javascript/auth)
- [Google sign-in](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Passwordless email sign-in](https://supabase.com/docs/guides/auth/auth-email-passwordless)
- [Custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security)
