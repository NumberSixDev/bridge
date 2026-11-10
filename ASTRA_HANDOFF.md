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
-   Staff IDs remain blank and reminders remain disabled. No Windows authentication cache was imported.
-   No live bot process, automatic startup or sleep changes were configured.

## Verification

-   `pnpm install --frozen-lockfile`: passed.
-   `pnpm test`: build and all eight offline tests passed.
-   `pnpm format:check`: formatting and lint passed.
-   `pnpm check-config`: only missing Minecraft email and Discord token reported.
-   Git ignores `.env` and `.minecraft-auth/`.
-   Live Minecraft/Discord behaviour remains unverified. The reported GitHub billing lock was not changed.

## Next steps

1. Ben creates/invites the Discord bot, enables Message Content Intent, and grants View Channel, Send Messages and Embed Links in the configured channel.
2. Ben saves the Discord token and Minecraft Microsoft email directly in the local `.env`, then confirms readiness. Do not print credentials.
3. Re-run `pnpm check-config`, start the bridge, and let Ben complete Microsoft device-code sign-in.
4. Verify server/version compatibility, guild access, one message each direction, no duplicate echoes, channel isolation and reconnect behaviour.
5. After live verification, supervise the process with the bundled PM2 tooling. Get Ben's decision before automatic startup or sleep changes.

## Scoped changes

-   `pnpm-workspace.yaml`: pnpm build-script permission required on this Mac.
-   `AGENTS.md`: required GitHub account.
-   `ASTRA_HANDOFF.md`: setup evidence and remaining live checks.
