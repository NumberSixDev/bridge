# Guild Bridge recruitment

Updated 10 November 2026. Status: IMPLEMENTED LOCALLY; release/live check in progress.

## Target and authority

-   Existing checkout `/Users/ben/Documents/ChatGPT/Guild Bridge`, branch `feat/dragsim-guild-chat`.
-   origin NumberSixDev/bridge; upstream MiscGuild/bridge. Authenticate as NumberSixDev, never Fixerq. Commit/push all finished changes; never credentials, auth caches or `.bridge-data/`.
-   Ben authorised this recruitment implementation and normal live delivery. Auto-accept must start OFF, thresholds unset. Admin role 1569762077592125510 and Guild Master role 1569548424884387850 exclusively control recruitment.
-   Use existing guild-bridge channel. No new startup or sleep changes.

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
-   30 offline tests pass, plus build, formatting/lint and configuration validation. Includes exact API paths, both thresholds, bad/missing/stale/private/partial data, role isolation, settings modal/buttons, concurrency, disconnection, persistence failure, restart recovery and Discord delivery retry.
-   Admin/Guild Master roles and existing guild-bridge channel verified via Discord API.
-   Existing accept-everyone mode was disabled locally before implementation. Old supervised service was reconnected successfully.
-   Delegated execution stopped at its 20-minute deadline; no child remains. Owner corrected API route, recovery/decision races and completed additional tests. No unfinished delegated changes remain.

## Runtime and remaining verification

-   Node22.22.3, pnpm11.1.2, Minecraft1.21.4 as LabGeek2; native LaunchAgent `com.numbersixdev.dragsim-guild-bridge` runs `dist/src/index.js`. PM2 unused.
-   Credentials remain private in .env/.minecraft-auth. Never sign the Minecraft bot account into another client.
-   Pending: scoped commit/push, supervised restart, slash registration and live application/panel readback. Real admin button/admission proof may require Ben.
-   macOS CUA screen capture failed (SCStreamError -3811); no successful Discord UI test is claimed. Discord API is working.
