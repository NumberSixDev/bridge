# DragSim Guild Bridge

A two-way bridge between one DragSim guild chat and one Discord text channel.
Forked from [MiscGuild/bridge](https://github.com/MiscGuild/bridge), under the MIT licence.

## Behaviour

-   Connects to `dragsim.co` using a Minecraft Java account and Microsoft sign-in.
-   Acknowledges the server resource pack and uses `/warp hub` to leave the profile selector before enabling guild chat.
-   Sends Discord messages as `/gc DisplayName > message`.
-   Recognises guild messages with optional server-rank prefixes and guild-role suffixes, such as `Guild > [MOD] DragSim [GM]: hello`, as well as unranked players. Any bracketed tags are supported, including multiple tags together.
-   Everyone with access to the configured Discord channel can use the bridge.
-   Keeps original Discord messages and suppresses the Minecraft bot's own echo.
-   Ignores other Discord channels, other servers, bot/webhook messages and messages beginning with `)`.
-   Relays text only. Text accompanying an attachment is relayed; the attachment itself is not.
-   Does not relay public Minecraft chat, officer chat, private messages or unrecognised guild announcements.
-   Disables Discord mention notifications in relayed messages.
-   Rejects messages exceeding Minecraft's 256-character limit, including `/gc `, the author and separator.
-   Reconnects after a connection ends and supports optional guild reminders.
-   Records guild join applications with profile summaries and persistent Accept/Deny controls.
-   Supports a persistent recruitment settings panel with optional thresholded automatic acceptance.
-   Provides public `/gleaderboard` rankings for current Minecraft guild members with paginated buttons.

The original Hypixel API lookups, Limbo commands, member-count polling, guild
moderation commands and blacklist integration have been removed. There is no
Hypixel API key or second Discord channel to configure.

## Requirements

-   Node.js 22 or newer and pnpm.
-   A Minecraft Java account that can connect to DragSim, join the guild and use `/gc`.
-   A Discord bot invited with the `bot` and `applications.commands` scopes.
-   Message Content Intent enabled for that bot.
-   View Channel, Send Messages and Embed Links permissions in the target channel.
-   Manage Channels permission only if you want the optional `/slowmode` command.

The default Minecraft protocol is `1.21.4`, based on the supplied server
requirements. It is configurable. Confirm the version accepted by DragSim during
the first live connection; a proxy's advertised version may differ from its backend.

## Setup on the Mac

Ben’s existing Mac checkout is `/Users/ben/Documents/ChatGPT/Guild Bridge`. Use this checkout when operating the installed service.
From that directory:

```sh
pnpm install --frozen-lockfile
pnpm setup-files
```

Edit the local `.env` file:

| Setting                        | Value                                                        |
| ------------------------------ | ------------------------------------------------------------ |
| `MINECRAFT_HOST`               | `dragsim.co`                                                 |
| `MINECRAFT_PORT`               | `25565`                                                      |
| `MINECRAFT_VERSION`            | `1.21.4`, or another confirmed compatible version            |
| `MINECRAFT_CHAT_COMMAND`       | `/gc`                                                        |
| `MINECRAFT_JOIN_COMMAND`       | `/warp hub` to leave DragSim's profile selector              |
| `MINECRAFT_EMAIL`              | Microsoft account email for the bot                          |
| `DISCORD_TOKEN`                | Discord bot token                                            |
| `DISCORD_SERVER_ID`            | The Discord server ID                                        |
| `MEMBER_CHANNEL_ID`            | The single guild-chat channel ID                             |
| `RECRUITMENT_ALLOWED_ROLE_IDS` | Comma-separated roles allowed to manage recruitment          |
| `RECRUITMENT_CHANNEL_ID`       | Application destination, independently of the settings panel |
| `RECRUITMENT_DATA_DIR`         | Local ignored directory for recruitment state                |
| `RECRUITMENT_API_BASE_URL`     | Official HTTPS API base, default `https://dragsim.co/api/`   |

Keep credentials in `.env`. Microsoft tokens are stored locally in
`.minecraft-auth/`. Both are ignored by Git. Do not copy personal authentication
caches from Windows or commit either location.

```sh
pnpm build
pnpm check-config
pnpm start
```

`check-config` validates settings without connecting to either service. On first
start, complete the Microsoft device-code sign-in in your own browser. The bot
only starts the Minecraft connection after checking the Discord channel.

Leave `REMINDER_ENABLED=false` unless reminders are wanted. Messages beginning
with `DISCORD_IGNORE_PREFIX` are kept in Discord without being relayed. The
optional profanity filter is a local filter, not a guarantee of server acceptance.

## Guild recruitment

The exact server notice `Guild » Eletc has requested to join your guild!` creates
one persistent application. The application first fetches the player's selected
profile and then the matching official networth snapshot. Private, stale, partial,
uncertain or incomplete data always goes to manual review; the estimated networth
already includes purse and is never increased a second time by the bridge.

Automatic acceptance is disabled by default; manual applications are enabled. The two roles in
`RECRUITMENT_ALLOWED_ROLE_IDS` can use `/recruitment panel`,
`/recruitment requirements`, `/recruitment auto` and `/recruitment status`.
Run `/recruitment panel` in the text channel where you want recruitment managed.
It posts the settings embed only when this command is run. It is never created on startup.
Applications always use the separate `RECRUITMENT_CHANNEL_ID` (or `MEMBER_CHANNEL_ID` if unset);
posting the settings panel somewhere else does not change the application destination.
Running it in another channel moves the panel and disables the old panel’s controls.
Existing applications retain their original cards. The command reply links directly to the panel.
Use **Edit minimums** to enter values such as `1B` and `100M`, then **Enable auto acceptance**
when ready. Leave a field blank or use `none` to clear it and disable automatic acceptance.
The explicit Enable/Disable buttons are safe to click more than once. Both non-negative minimums must be set before auto
acceptance can be enabled, and comparisons are inclusive. A setting change does
not retroactively accept existing applications.

Automatic acceptance sends `/g accept <username>` only after both current
thresholds pass, the Minecraft connection is ready and the decision has been
persisted. `Acceptance sent` is not proof of server membership. Manual Deny is a
local suppression only because the server's decline command is not verified; the
bridge does not guess one. The legacy `GUILD_AUTO_ACCEPT_ENABLED` setting is
retained only for configuration compatibility and cannot bypass recruitment.

Settings and applications are stored locally in `.bridge-data/recruitment.json`
(directory mode 0700, file mode 0600), excluded from Git and formatting. Pending
applications and controls survive restart. Interrupted acceptance attempts are
marked **Needs verification** and are never automatically resent. Duplicate
notices are suppressed while pending and for 60 seconds after a decision. Closed
records are retained for up to 30 days within a 1,000-application capacity.

The bridge uses only `https://dragsim.co/api/player/<username>?mode=main` and
`https://dragsim.co/api/networth/<username>?mode=main&profile=<id>`. No extra
API key, external price service or AI API is needed. Both endpoints were checked
live on 10 November 2026. Saved-profile, calculation and market timestamps must
be within five minutes; missing, private, partial, unpriced or uncertain data goes
to manual review. The sample profiles were partial, so a large displayed total
alone is not sufficient for automatic admission. The panel explains this policy.

## Guild leaderboards

`/gleaderboard` ranks only the members returned by the bot's own `/g list`.
The roster must contain complete, count-matched Guild Master, Admin, Staff,
Bridge and Member groups before it can be used. A complete roster is cached for
up to ten minutes, refreshes in the background every ten minutes while connected, and is cleared on disconnect; an incomplete or failed refresh
is never used as a stale fallback.

Available categories are `networth`, `purse`, `collections`, `skills`,
`bestiary`, `slayer`, `dungeons`, `mining`, `currencies`, `stats` and `rng`.
Categories with multiple safe metrics provide autocomplete. Rankings use the
official HTTPS player and networth endpoints, fetch at most two players at a
time, omit failed or unavailable values rather than treating them as zero, and
show partial networth estimates with an approximate marker. Inventory contents
and other private item data are never displayed. Results are stable for the
ten-minute button session, which is bound to its original guild, channel and
message; buttons also re-check current membership before changing page.

## Optional staff commands

`/help` is public. `/command`, `/slowmode` and `/terminate` require the configured
`BOT_OWNER_ID` or `STAFF_ROLE_ID`; both can stay blank to deny everyone access.
All commands are registered only in the configured Discord server.

`/command` reports that a command was sent, not whether DragSim accepted it.
`/terminate` stops the current session; a process supervisor may restart it.

## Checks

```sh
pnpm test
pnpm format:check
```

The tests use fake connections and do not sign in to Minecraft or Discord.
The build clears its own `dist/` directory before compiling, so removed
Hypixel handlers cannot survive in an old build.

Before leaving it running, verify one message in each direction, no duplicate
echo, non-guild chat isolation, and reconnection on the actual Mac. If guild
prefixes differ from the supplied example, adjust the parser using real examples.

## Keeping it running

The Mac must stay powered on, connected to the network and awake. Ben's Mac uses
an approved user LaunchAgent, `com.numbersixdev.dragsim-guild-bridge`, to start the
bridge at login and restart it if it exits. It runs the built application from
this checkout and reads the local `.env`. Logs are in `logs/launchd.log` and
`logs/launchd-error.log`.

```sh
# Check the running service
launchctl print "gui/$(id -u)/com.numbersixdev.dragsim-guild-bridge"

# Stop it, including automatic restarts for the current login session
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.numbersixdev.dragsim-guild-bridge.plist"

# Start it again
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.numbersixdev.dragsim-guild-bridge.plist"
```

Do not sign the bot's Minecraft account into the game while the bridge is using
it. Normal play and relay tests should use a different account.

PM2 is an alternative for installations without the LaunchAgent. Do not run both
supervisors for the same bot:

```sh
pnpm pm2:start
pnpm pm2:kill
```

`pm2:kill` removes only the process named `bridge`; it does not stop the LaunchAgent.

## Attribution

The original project includes adaptations from
[hychat-mc/self-host](https://github.com/hychat-mc/self-host),
[xMdb/hypixel-guild-chat-bot](https://github.com/xmdb/hypixel-guild-chat-bot), and
[unaussprechlich/hypixel-api-typescript](https://github.com/unaussprechlich/hypixel-api-typescript).
See [LICENSE](LICENSE).

Leaderboard rows display server ranks from the official player API (for example `[MVP+]`) beside each name. Default/unranked players have no prefix. Networth with private inventory is omitted; partial public valuations are labelled estimated.
