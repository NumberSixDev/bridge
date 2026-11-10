# DragSim Mac setup

Updated: 10 November 2026. Status: running and verified live.

## Target and authority

-   Project: `/Users/ben/Documents/ChatGPT/Guild Bridge`. Keep this existing project and chat.
-   Branch: `feat/dragsim-guild-chat`; `origin`: `NumberSixDev/bridge`; `upstream`: `MiscGuild/bridge`.
-   Authenticate as `NumberSixDev`, never `Fixerq`. Commit and push completed project changes to the feature branch.
-   Keep credentials in the ignored `.env` and `.minecraft-auth/`; never print or commit them.
-   Ben approved automatic startup at Mac login on 10 November 2026. Sleep settings were not changed.

## Current runtime

-   Bot account: `LabGeek2`; Ben reports it has the guild's `BRIDGE` rank.
-   DragSim `dragsim.co:25565` accepts Minecraft `1.21.4` in the verified live connection.
-   Node.js `22.22.3`, pnpm `11.1.2`; frozen-lockfile dependencies installed.
-   Local credentials, Discord channel/server IDs and optional owner/staff IDs are configured. Reminders remain disabled.
-   Microsoft sign-in is cached locally. `.env` mode is `0600`; `.minecraft-auth/` mode is `0700`. No Windows cache was imported.
-   Supervisor: user LaunchAgent `com.numbersixdev.dragsim-guild-bridge`, installed at `/Users/ben/Library/LaunchAgents/com.numbersixdev.dragsim-guild-bridge.plist`.
-   It runs the checkout's `dist/src/index.js` at login and restarts the process after exit. PM2 is not running this bot.
-   Operational commands are in `README.md`. Logs: `logs/launchd.log`, `logs/launchd-error.log`, and `logs/error.log`.
-   The Mac already has sleep disabled on mains power; that existing setting was preserved.

## Connection fixes

-   DragSim sends a resource pack during protocol configuration. The bridge acknowledges its exact raw UUID, avoiding Mineflayer 4.37.1 issue #4043.
-   New connections land in a profile selector where guild sends are rejected. Local `MINECRAFT_JOIN_COMMAND=/warp hub` is now configured; the bridge waits for the hub spawn before announcing readiness.
-   The join step runs after reconnects too. A transfer timeout reconnects rather than falsely announcing readiness.
-   Disconnect reasons are visible in logs. Formatting excludes local authentication files.
-   Guild parsing supports optional server-rank prefixes and optional guild-role suffixes. All bracketed tags are preserved, including multiple or previously unknown tags; untagged players and own-echo suppression remain supported.
-   Source implementation through `823652805e9149d4ac8e3aeaaca7085ccd31629f` was pushed and verified on the remote feature branch; later documentation commits retain the same runtime code.

## Verification

-   `pnpm test`: build and all eleven offline tests passed, including resource-pack wire UUIDs, hub readiness gating, and 120 prefix/suffix combinations passed through the actual relay handler.
-   `pnpm format:check`: formatting and lint passed.
-   `pnpm check-config`: passed.
-   Discord intent/channel permission checks passed; the configured staff role exists.
-   Live Discord-to-Minecraft test: received by the bot, emitted as `/gc`, and observed in actual server guild chat.
-   Live Minecraft-to-Discord test: received in guild chat and delivered once to the configured Discord channel.
-   Discord readback confirmed the original message remains, one incoming guild copy, zero own-echo duplicates, and zero messages from the tested other channel.
-   A controlled network drop triggered the 15-second reconnect, resource-pack acknowledgement and automatic hub entry.
-   A controlled supervised process stop produced a new process and a fresh successful DragSim connection. Both error logs were empty afterwards.
-   Startup at login is installed and loaded; the Mac was not rebooted as part of testing.
-   The previously reported GitHub Actions billing lock was not changed; local and live checks supply the verification evidence.

## Operational constraints

-   Leave the bot account disconnected from the Minecraft game client while the bridge runs. Concurrent use causes DragSim's `You are already connected to this proxy!` rejection.
-   Use the LaunchAgent commands to stop or restart this Mac's service; starting another copy with pnpm or PM2 would duplicate the account session.
-   Keep the Mac powered on, logged in, connected and awake. No required setup work remains.
