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

Use a checkout of this fork containing the DragSim changes under `~/Projects/Guild Bridge`.
From that directory:

```sh
pnpm install --frozen-lockfile
pnpm setup-files
```

Edit the local `.env` file:

| Setting                  | Value                                             |
| ------------------------ | ------------------------------------------------- |
| `MINECRAFT_HOST`         | `dragsim.co`                                      |
| `MINECRAFT_PORT`         | `25565`                                           |
| `MINECRAFT_VERSION`      | `1.21.4`, or another confirmed compatible version |
| `MINECRAFT_CHAT_COMMAND` | `/gc`                                             |
| `MINECRAFT_JOIN_COMMAND` | `/warp hub` to leave DragSim's profile selector   |
| `MINECRAFT_EMAIL`        | Microsoft account email for the bot               |
| `DISCORD_TOKEN`          | Discord bot token                                 |
| `DISCORD_SERVER_ID`      | The Discord server ID                             |
| `MEMBER_CHANNEL_ID`      | The single guild-chat channel ID                  |

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
