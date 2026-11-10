# Guild leaderboards

Updated 10 November 2026. Owner: Astra. Status: PUSHED, DEPLOYED, roster/API verified; awaiting Ben's Discord page-navigation confirmation.

## Goal and decisions

-   Public `/gleaderboard` ranks current Minecraft guild members highest first, with API server-rank labels and 25 rows per page. Anyone in the configured Discord server can use it and the left/right buttons.
-   Public `/refresh` forces the complete guild roster and leaderboard API caches, with single-flight execution, a one-minute global cooldown and protection against old in-flight responses refilling cleared caches. Existing boards remain snapshots.
-   Categories: networth, purse, collections, skills, bestiary, slayer, dungeons, mining, currencies, stats and RNG. Optional stat autocomplete selects individual metrics. XP, levels and counts stay distinct.
-   Membership comes exclusively from the bot's `/g list`, all five rank groups and exact counts. The live separator is `●`; the parser also supports `•`. Complete rosters cache for ten minutes, refresh in the background every ten minutes while connected and clear on disconnect. Never use applicants, Discord roles or the global top 25 as membership.
-   Official HTTPS player and networth API, selected main profile identity checks, two concurrent requests, bounded time/body/retry handling and shared rate-limit backoff. Five-minute in-memory stats cache; no inventory payload cached or committed. Private networth omitted, partial public networth marked approximate, unavailable data excluded rather than zeroed. Ben requested removal of the verbose partial-estimate summary line.
-   Rank enums map to visible labels: MVP_PLUS -> MVP+, VIP_PLUS -> VIP+; DEFAULT has no prefix. All labels are sanitised/escaped.
-   Sessions bind to guild/channel/message, expire after ten minutes and have bounded storage. Paging reuses stats and checks current membership; departed members are filtered before initial publication and after roster refresh on paging. No automatic leaderboard posts.

## Target and authority

-   `/Users/ben/Documents/ChatGPT/Guild Bridge`, `feat/dragsim-guild-chat`, origin NumberSixDev/bridge, upstream MiscGuild/bridge. NumberSixDev only. Commit/push all completed changes, never .env, .minecraft-auth or .bridge-data.
-   Ben authorises normal live delivery/restart of the existing LaunchAgent. No second Minecraft connection, startup/sleep changes or recruitment-setting changes.
-   Native service `com.numbersixdev.dragsim-guild-bridge`, Node22, Minecraft1.21.4 as LabGeek2. Sources compile to dist/src/index.js.

## Verification and current state

-   Source commits `4834476`, `aedda4e` and `d3239fd` pushed to origin and deployed via existing LaunchAgent. The subsequent /refresh command is locally verified and awaiting release.
-   All 50 tests pass, including build; formatting/lint and check-config pass. Tests cover roster parsing/counts/chat-spoof rejection, cache, missing/private data, rank display, sorting, page boundaries/channel isolation, departed members/expiry and rate limiting.
-   Live Discord API confirms all eleven `/gleaderboard` subcommands registered.
-   Live bot confirmed 83 members across all five guild ranks after the separator correction.
-   Real API client verified profiles, networth, rank mapping and all categories for two members. Their networth is partial and displayed as an estimate. No inventories retained in the stats cache.
-   Ben was asked to run `/gleaderboard networth` and use both arrows. Awaiting confirmation/readback of that actual user journey.
-   Coordinator timed out after leaving its implementation and passing-check handoff; owner completed review fixes, rank labels, additional tests, push and deployment. No coordinator remains running.

## Files

src/leaderboard/\*, src/discord/commands/gleaderboard.ts, src/discord/events/interaction-create.ts, src/bridge.ts, src/mineflayer/mineflayer.ts, tests/leaderboard.test.cjs and README.md.

---

## Historical recruitment context

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
