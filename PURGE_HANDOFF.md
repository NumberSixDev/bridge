# Guild purge

Updated 10 November 2026. Owner: Astra. Status: implemented; 67 tests and local checks pass; live release verification pending.

## Target and authority

-   Existing Mac checkout `/Users/ben/Documents/ChatGPT/Guild Bridge`, branch `feat/dragsim-guild-chat`. origin NumberSixDev/bridge, upstream MiscGuild/bridge. NumberSixDev identity verified. Ben authorises commit/push and restart of the existing LaunchAgent. Do not use Fixerq, change startup/sleep/billing or create a second Minecraft login.
-   Ben requested the feature, including its Discord confirmation step. Agents must not run a real purge to test it. Real removal requires an authorised user to confirm the exact target list in Discord.
-   Credentials, authentication, caches and exclusions remain local/ignored. No dependencies added.

## Implemented decisions

-   `/purge` opens a panel in the invoking channel. Only the existing configured Admin/Guild Master roles can operate any control; fresh role checks are reused from recruitment, without owner/staff bypasses or duplicate pre-acknowledgement lookups.
-   Uses both saved recruitment minimums, independent of auto-accept. A member failing either minimum is a candidate. Equality meets a minimum. Each row shows networth and purse ticks/crosses and compact amounts; unavailable/private data is review-only.
-   25 complete rows/page and a matching paginated dropdown. Selecting a name toggles exclusion/reinclusion. Saved exclusions persist in ignored `.bridge-data/purge.json`, scoped to the configured Discord guild, bounded, atomic and private. Concurrent writes are serialized; storage errors disable purge.
-   Ben explicitly selected using the displayed networth estimates, including partial values. Root set local `PURGE_ALLOW_PARTIAL_NETWORTH=true`; template defaults false. Recruitment auto-admission quality rules are unchanged. Fresh API retrieval/calculation is required for kicks; an offline profile's last save time is not misrepresented as a new save.
-   Protect the bot and the Guild Master. Other ranks are subject to requirements unless excluded. A read-only `/g help` probe must verify the kick syntax on the existing connection before the red Purge button can operate.
-   Red Purge performs a bounded fresh roster/API preflight, then displays a frozen, paginated target list. The final confirmation has an actor-bound, one-use nonce and independent two-minute expiry. Old/replaced/duplicate buttons cannot confirm a different set. Requirement/exclusion changes invalidate it. Newly qualifying or newly joined members cannot be added silently.
-   A single sequential job re-fetches each player's evidence and rechecks current authority/settings/exclusions/readiness immediately before dispatch. Disconnect or shutdown cancels continuity. After each kick it verifies removal with a fresh complete roster; unconfirmed removal stops the remaining batch. No retries or automatic restart of destructive work. Completed panels cannot start another job.
-   Existing guild chat, recruitment settings and all leaderboard commands remain intact.

## Verification

-   `pnpm test`: TypeScript build and all67 tests pass. Formatting/lint, configuration validation and diff whitespace pass.
-   Regression coverage includes either/both/equality comparisons, partial policy/privacy/freshness, page/select bounds, persisted exclusions, concurrent selections, corruption/write failure, denied roles, wrong actor/channel/expired controls, stale nonces, duplicate confirmation, changed requirements/exclusions/roles during fresh lookup, newly compliant members, frozen membership, disconnect/shutdown, successful verified removal and stop after an unconfirmed command.
-   Coordinator ended at its time cap. Root resolved build/lint failures, completed the focused safety review and added the concurrency/replay/authority regression cases. No worker remains active.
-   Live command registration, capability probe and panel check are pending. No real kicks have been sent by agents.
