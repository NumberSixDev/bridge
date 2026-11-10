# Guild leaderboard task

## Goal and owner

Ben requests public Discord `/gleaderboard` commands ranking ONLY current Minecraft guild members, descending, across all available useful numeric player stats, with previous/next arrow buttons. Astra owns decisions and final live delivery. Status READY FOR ASTRA REVIEW; live release outstanding.

## Verified context and authority

-   Repo `/Users/ben/Documents/ChatGPT/Guild Bridge`, branch `feat/dragsim-guild-chat`, starting clean HEAD `667e12ae50edd8b752ecc1511a98a798231fcfa7`. origin NumberSixDev/bridge, upstream MiscGuild/bridge; fetched and 0 ahead/behind. GitHub NumberSixDev only.
-   Ben authorises implementation, scoped commit/push and restart of the established Mac LaunchAgent. OWNER handles commit/push/restart/live verification after your work. Do not launch a second Minecraft connection or alter startup/sleep settings.
-   Preserve recruitment, bridge, current .env/settings and credentials. Never commit .env, .minecraft-auth, .bridge-data or player data. No dependency upgrades. You are not alone; preserve others' edits.
-   Coordinator owns implementation files, tests, README and THIS top handoff section. No other workers needed. Do not spawn nested agents or repeat root bootstrap. Scope complete implementation locally, deterministic checks and concise final report; no Git commit/push or live messaging by coordinator.

## Approved architecture

1. New leaderboards module with testable roster collector, bounded HTTPS data client, metric extraction/catalogue, cache and Discord pagination service. Wire to Bridge, Minecraft messages/ready/disconnect/stop and Discord interaction routing. Existing public command loader registers the new command; all users in configured Discord guild may use it, independent of staff recruitment roles.
2. Authoritative roster is bot's own `/g list`. Ben supplied screenshots: exact headers `Guild Master [1]`, `Admin [6]`, `Staff [3]`, `Bridge [1]`, `Member [71]`; each followed by usernames optionally prefixed with one or more rank tags, separated by bullet `•`. Counts above are examples, NOT constants. Message wrapping on the screenshot may be client wrapping only; support multiline strings and separate messages. Strip Minecraft colour codes, ignore brackets in rank prefixes, validate usernames with /^[A-Za-z0-9_]{1,16}$/. Require ALL five recognised rank groups and exact per-group count match, unique names, reasonable cap 500. Never treat guild chat, join applications or Discord roles as a roster. Begin parsing only exact Guild Master header during an active requested query; ignore unrelated chatter. Resolve as soon as all groups complete; timeout 10s or disconnect rejects incomplete data. Single-flight query, cache complete roster 60s; no stale roster fallback on refresh error. Refresh after Minecraft hub ready, then on command/button as needed. Handle disconnect by clearing roster. Public method getRoster(): Promise<{guildName?:string,members:string[],observedAt:number}> is fine. No need to infer guild name if absent.
3. Official player API verified live: GET https://dragsim.co/api/player/{username}?mode=main returns mode, fetched_at, player:{uuid,player,rank}, profiles:[{id,name,mode,selected}], profile:{id,profile_name,profile_mode,updated_at,inventory_hidden,...}. Validate returned username, UUID/profile identity and selected main NORMAL profile. GET /api/networth/{username}?mode=main&profile={id} returns profile_id, mode, total (includes purse), hidden, partial, calculated_at etc. Read src/recruitment/api.ts for proven patterns; do not change recruitment policy. Fetch bounded/timeout/HTTPS redirect error, cap response size; concurrency at most 2 across requests and handle 429/backoff without retry storms. Profiles cached ~5 minutes, per-player failures omitted and counted, never represented as zero. Networth only fetched for networth requests; partial estimates allowed for DISPLAY with a concise approximate marker/footnote, private networth omitted. Other public API stats available regardless of inventory privacy. Profile timestamps may be old for offline players: display data age honestly rather than excluding all offline members. No global top-25 endpoint or paid APIs.
4. Verified numeric schemas: profile.coins (purse), motes,bits,haunted_candy_earned,dragon_essence,draconic_experience; skills:{combat,mining,taming,catacombs} values are XP; collections:{obsidian,ender_stone,summoning_eye,crying_obsidian,rough_amethyst,null_ovoid,...} counts; bestiary:{MOB_KEY:{kills}}; slayer:{zombie_xp,zombie_level,enderman_xp,enderman_level}; dungeons:{secrets,zombie_kills,skeletor_kills,class_xp:{CLASS:value},completions:{F7:value},best_score:{F7:value},essence:{TYPE:value}}; hotd:{tier,exp,core,ender,void,resets,tokens,nodes:{KEY:level}}; rng_meters:{KEY:{kills}}; stats:{base:{stat:number},additive:{},multiplicative:{},increase_max:{}}. Do not present XP as level or base stats as effective gear stats. No inventories/private item dumps. Include numeric leaves of these explicitly allowed paths, plus meaningful totals (collections items, bestiary kills, skills XP, slayer XP, dungeon completions), NOT totals of unrelated values. Sparse missing keys in an otherwise valid API counter map can mean 0 only when that source map is present and valid; missing source maps or players remain unknown.
5. `/gleaderboard networth`, `/gleaderboard purse`, plus category subcommands collections, skills, bestiary, slayer, dungeons, mining, currencies, stats, rng with optional `stat` autocomplete where needed (<=25 choices per reply, bounded safe keys). Support all numeric leaves in these confirmed namespaces; default meaningful total or key per category. Autocomplete must respond promptly using catalogues/cache, never full-network refresh per keystroke. Known metric seeds plus discovered keys are suitable. Validate requested stat; do not evaluate arbitrary paths. User-friendly labels incl units XP/kills/base stat. Empty/unavailable results honest, no silently ranking outside guild.
6. Public embed, ten rows/page descending numeric values, deterministic ties alphabetical. Compact amounts reuse formatAmount. Include ranked/roster counts and snapshot age; unavailable count and partial networth note concise. Buttons left/right disabled at boundaries, `Page X/Y`; sessions bound to bot message ID/channel/configured guild, TTL ~10 minutes, bounded session/cache counts. Anyone in that Discord channel can navigate. Defer command immediately before network work; defer button update promptly. IDs validate strictly, forged/wrong message/channel/server rejected, expired sessions respond privately telling user to rerun. Page snapshots stable (no API refetch for every page), but get fresh roster as needed and exclude anyone no longer a member; if roster refresh fails don't show stale membership. Coalesce concurrent fetches to prevent 82-member lookup storms; per-user command cooldown. Newly joined members can appear on next command; snapshot label explains scope. No new startup panels or unsolicited leaderboard posts.

## Acceptance criteria

-   Tests demonstrate roster parsing colours/prefixes/multiline/zero-count groups, mismatch/incomplete/timeout/disconnect and ignoring chat spoofing; only complete guild roster accepted.
-   Metric extraction identity/privacy/missing/invalid numeric handling; descending/ties, >10 players multiple pages, under-10 one page, failures omitted, total types correct, cache/single-flight.
-   Public command and button handling boundaries/expired/forged IDs, guild/channel/message isolation and membership removal; recruitment tests unchanged.
-   pnpm test (includes build), pnpm format:check. Fix concrete in-scope failures. No fake live claims.
-   Owner then registers commands via normal service restart, verifies `/g list` roster count live, actual API rankings and Discord embed/buttons/readback, commits/pushes all completed scoped changes as NumberSixDev and verifies remote SHA. Real user button journey may require Ben.

## Execution state

-   Owner review added API server-rank labels (including MVP_PLUS -> MVP+), strict full-line roster parsing, private-networth exclusion, missing-currency handling, roster revalidation after long lookups, a two-minute lookup budget, shared API rate-limit backoff and omission of inventories from the cache.
-   Owner verification: all 48 tests, build, formatting/lint and configuration checks pass. NumberSixDev identity verified. Coordinator invocation timed out after leaving its completed implementation and handoff; no coordinator run remains active.
-   Implemented locally in `src/leaderboard/` with strict five-group `/g list` collection, 60-second complete-roster cache, disconnect invalidation, official bounded HTTPS profile/networth client, two-request limiter, one bounded 429 retry, five-minute in-memory profile/networth caches, safe metric catalogue/extraction, ranking snapshots, and Discord pagination sessions.
-   Wired public `gleaderboard` command registration, autocomplete, button routing, Minecraft `messagestr` handling, ready refresh, disconnect clearing and shutdown cleanup. Recruitment routing and policy were preserved.
-   Added `tests/leaderboard.test.cjs` covering roster colours/prefixes/multiline/zero groups, spoof rejection, mismatch/timeout/disconnect, single-flight/cache, metric identity/privacy/missing/invalid handling, API identity/429 handling, ranking order, ten-row pagination and channel isolation.
-   Updated `README.md` with the public leaderboard behaviour and safety boundary.
-   Verification passed locally: `pnpm test` (43 tests, including build), `pnpm format:check` (Prettier and ESLint), the TypeScript build and `pnpm check-config` (configuration valid; no accounts connected).
-   No commit, push, LaunchAgent restart, live `/g list`, Discord registration, API ranking readback or button journey was performed by this coordinator. Owner must perform those gates with the established account and one existing Minecraft connection.
-   No known implementation blocker remains. Final status: READY FOR ASTRA REVIEW.

---

# Guild Bridge recruitment

Updated 10 November 2026. Status: PUSHED and DEPLOYED; real application cards and manual command observed.

## Target and authority

-   Existing checkout `/Users/ben/Documents/ChatGPT/Guild Bridge`, branch `feat/dragsim-guild-chat`.
-   origin NumberSixDev/bridge; upstream MiscGuild/bridge. Authenticate as NumberSixDev, never Fixerq. Commit/push all finished changes; never credentials, auth caches or `.bridge-data/`.
-   Ben authorised this recruitment implementation and normal live delivery. Auto-accept must start OFF, thresholds unset. Admin role 1569762077592125510 and Guild Master role 1569548424884387850 exclusively control recruitment.
-   Applications go to explicitly selected channel 1569793036383162428 (`RECRUITMENT_CHANNEL_ID`). The settings panel is posted only by `/recruitment panel`, in the invoking channel; its location never changes the application destination. Existing cards stay where posted. No new startup or sleep changes.

## Implemented

-   Official HTTPS profile and per-player networth lookups, selected-profile identity checks, privacy/freshness/coverage checks, bounded serial fetches. Networth already includes purse.
-   Exact join notices create persistent application cards with Accept/Deny. Both minimums must be met with complete current data for automatic acceptance. Other requests stay manual. No automatic rejection.
-   `/recruitment panel`, `/recruitment requirements`, `/recruitment auto`, `/recruitment status`; Edit minimums modal and explicit idempotent Enable/Disable buttons.
-   Fresh role checks on commands/buttons/modals, channel and persisted message checks, early interaction deferral, suppressed mention notifications.
-   Atomic private JSON state, serialized decisions/cards, restart recovery, bounded retries, repeated-request suppression and no old accept-all bypass. Settings changes during lookup keep those requests manual.
-   Acceptance is labelled sent, not confirmed membership. Deny closes the application locally; live `/g help` lists acceptance but no decline command. No guessed denial command is used.
-   Existing resource-pack UUID acknowledgement, hub readiness gating, reconnects, rank parsing and chat relay preserved.

## Evidence

-   Live HTTP200 profile, official networth and external price-service checks succeeded. Runtime uses only the official HTTPS endpoints. Completed client verified live for two owned accounts: identity, purse and networth available; both valuations partial and therefore manual.
-   34 offline tests pass, plus build, formatting/lint and configuration validation. Includes exact API paths, both thresholds, bad/missing/stale/private/partial data, role isolation, settings modal/buttons, concurrency, disconnection, persistence failure, restart recovery and Discord delivery retry.
-   Admin/Guild Master roles and existing guild-bridge channel verified via Discord API.
-   Existing accept-everyone mode was disabled locally before implementation. Old supervised service was reconnected successfully.
-   Delegated execution stopped at its 20-minute deadline; no child remains. Owner corrected API route, recovery/decision races and completed additional tests. No unfinished delegated changes remain.

## Runtime and remaining verification

-   Node22.22.3, pnpm11.1.2, Minecraft1.21.4 as LabGeek2; native LaunchAgent `com.numbersixdev.dragsim-guild-bridge` runs `dist/src/index.js`. PM2 unused. Credentials remain private in .env/.minecraft-auth; no second Minecraft login is allowed.
-   Runtime `cc9bbd25ca34929903190ec7f4e24c86306f6dae` is pushed/deployed, including separate application routing and deleted-panel recovery. The service was restarted and connected successfully.
-   All four slash commands registered live; fresh supervised DragSim connection confirmed. Ben confirmed the final panel and Edit minimums form both work after channel routing was corrected.
-   Application destination is pinned locally to 1569793036383162428. Bot View Channel, Send Messages, Embed Links and Read Message History permissions verified there. Panel location is independently chosen by the invoking slash-command channel. No panel is created on startup; deleted panels stay absent until requested.
-   Auto acceptance remains off. Ben exercised the form and saved 1 coin for both minimums; those user-selected values were preserved. Prior accept-everyone mode is inert. Existing credentials/caches/startup/sleep configuration preserved.
-   Real application cards with purse/networth and active buttons were read back in the selected applications channel. The service observed an authorised manual acceptance button and sent its guild acceptance command; a final server-membership confirmation is pending from Ben. Offline tests cover manual Deny and automatic qualification; no automatic admission is claimed while the setting remains off.
-   macOS CUA capture failed; UI confirmation comes from Ben, and Discord state comes from API readback.

## Compact amount display

-   Application cards and settings summaries use lowercase k/m/b/t with up to two decimal places, truncated to match Ben’s examples (1,217,130,121.333 -> 1.21b; 5,812,272 -> 5.81m). Stored amounts and comparisons remain full precision.
-   Minimum fields accept case-insensitive suffixes including 15b, 100m, 250k and 2t; both modal fields have examples.
-   Release `19089a2b561d9207a783ede2e888fb85eb333cd5` is pushed and deployed. All 34 tests, formatting/lint and config validation pass. Existing application cards were refreshed and compact values read back from Discord; the bot reconnected successfully.

## Application requirement report

-   Display removes Minecraft profile colour/format codes (for example §7Wise becomes Wise).
-   A concise report at the top compares each amount with the current minimum, then suggests Accept, below-minimum manual review, data verification or setting the minimums. Advice is independent of the auto-accept switch and never performs a decision.
-   Open cards refresh their report when minimums change. Saved settings and full-precision comparisons are preserved.
-   Each requirement shows ✅ when met or ❌ when below the minimum. Missing values and unset minimums remain neutral.
-   37 offline tests cover formatting, boundary comparisons, missing/private/partial/stale evidence and refreshing reports without sending commands.

-   Application cards omit the verbose Coverage and Review lines and the acceptance-confirmation footnote at Ben’s request. The concise requirement report, status and operational notices remain; underlying eligibility checks and saved evidence are unchanged.
