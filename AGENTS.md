# Guild Bridge

## Delivery

-   Ben requires all completed changes to be committed and pushed to GitHub.
-   Push project changes to the appropriate branch of `NumberSixDev/bridge` (`origin`).
-   Authenticate as `NumberSixDev`. Do not use `Fixerq`; verify `gh api user --jq .login` before pushing.
-   Keep `MiscGuild/bridge` as `upstream`; do not push project changes there.
-   Verify relevant tests and the build before pushing. Confirm the remote branch contains the resulting commit.
-   Never commit `.env`, `.minecraft-auth/`, bot tokens or other credentials.
-   Preserve unrelated work. Do not infer permission to deploy a running bot or merge into production from permission to push a working branch.

## Current setup

-   Target host: Ben's Mac. Do not configure Windows as the production host.
-   Server: `dragsim.co`; initial configured Minecraft version: `1.21.4`.
-   Send guild messages using `/gc message`.
-   Expected incoming format: `Guild > [DRAGON] LabGeek: .`.
-   One Discord channel serves the whole guild, including officers and members.
-   Hypixel-specific API, Limbo, officer-channel, blacklist and original guild-administration behaviour is not used.
-   Ben authorised DragSim auto-accept: only the exact `Guild » <username> has requested to join your guild!` notice may trigger `/g accept <username>`, and only when `GUILD_AUTO_ACCEPT_ENABLED=true`.
-   Credentials are configured locally. The approved Mac LaunchAgent runs the bot; stop or restart that service instead of creating a second account connection.

## Checks

-   Runtime: Node.js 22 or newer and pnpm.
-   `pnpm test` builds and runs offline tests without connecting accounts.
-   `pnpm format:check` checks formatting and lint.
-   After building, `pnpm check-config` validates local settings without connecting accounts.
-   See `README.md` for Mac setup and the first live relay checks.
