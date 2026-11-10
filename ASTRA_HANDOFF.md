# DragSim Mac setup

Updated: 10 November 2026.

## Target and decisions

-   Existing Mac project: `/Users/ben/Documents/ChatGPT/Guild Bridge`.
-   Keep branch `feat/dragsim-guild-chat`; prepared implementation: `e9e57488fe480343466f94a3b1f33c9932ec2a5e`.
-   `origin`: `NumberSixDev/bridge`. `upstream`: `MiscGuild/bridge`.
-   GitHub account must be `NumberSixDev`, never `Fixerq`. NumberSixDev sign-in and fork admin access were verified on this Mac.
-   Commit and push completed changes to the feature branch. Never commit `.env` or `.minecraft-auth/`.
-   Keep the prepared DragSim implementation. Use Minecraft `1.21.4` until the first live connection establishes compatibility.
-   Ask Ben before automatic startup or sleep-setting changes.

## Implemented locally

-   Node.js `22.22.3` and pnpm `11.1.2` were already installed.
-   Dependencies installed with the frozen lockfile. `pnpm-workspace.yaml` permits only the locked `esbuild@0.28.1` install script.
-   `.env` created from `.env.template`, configured with the confirmed DragSim and Discord settings, and restricted to mode `0600`.
-   Credentials and owner/staff IDs are configured locally; reminders remain disabled. No Windows authentication cache was imported.
-   Microsoft device-code sign-in succeeded. The local authentication directory is restricted to mode `0700`.
-   Discord intent/channel checks passed and the configured staff role exists.
-   The bridge is stopped while Ben finishes the bot account's in-game setup. No automatic startup or sleep changes were configured.
-   Disconnect reasons are now included in log messages, and formatting checks exclude local authentication files.

## Verification

-   `pnpm install --frozen-lockfile`: passed.
-   `pnpm test`: build and all eight offline tests passed.
-   `pnpm format:check`: formatting and lint passed.
-   `pnpm check-config`: passed with the locally supplied credentials.
-   Git ignores `.env` and `.minecraft-auth/`.
-   DragSim rejected attempts while the same account was in the game: `You are already connected to this proxy!`. Retries were stopped.
-   Ben reports the account has joined the guild with the `BRIDGE` rank. Wait for it to disconnect from the game before retrying the bridge.
-   Minecraft spawn, protocol compatibility, live relaying and live reconnection remain unverified. The reported GitHub billing lock was not changed.

## Next steps

1. Wait for Ben to disconnect the bot account from DragSim and confirm readiness.
2. Start the bridge using the saved local credentials and Microsoft cache. Do not print credentials.
3. Verify server/version compatibility, guild access, one message each direction, no duplicate echoes, channel isolation and reconnect behaviour.
4. After live verification, supervise the process with the bundled PM2 tooling. Get Ben's decision before automatic startup or sleep changes.

## Scoped changes

-   `pnpm-workspace.yaml`: pnpm build-script permission required on this Mac.
-   `AGENTS.md`: required GitHub account.
-   `ASTRA_HANDOFF.md`: setup evidence and remaining live checks.
-   `src/mineflayer/mineflayer.ts`: show the server's disconnect reason.
-   `.prettierignore`: exclude local credentials and authentication caches.
