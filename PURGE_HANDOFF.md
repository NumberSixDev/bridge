# Guild purge

## Current execution policy, 12 November 2026

-   Ben explicitly requested kicking the list already provided, without repeated player API lookups or post-kick roster checks. This supersedes the historical fresh preflight and per-player verification policy below.
-   Opening Purge freezes eligible, non-excluded rows from the displayed panel. Admin/Guild Master roles and staff channel are checked on the confirmation interaction. The same actor, nonce, expiry and single-job rules remain.
-   First command is immediate; later commands are paced at1000ms from the preceding send. There is no final delay, no per-player REST role lookup and no roster/player lookup during confirmation or execution. Result wording counts commands sent rather than asserting confirmed removals.
-   Permanent exclusions, bot/Guild Master protection, settings/exclusion changes, disconnect/shutdown and send failures still guard local dispatch. No new target can be added to the confirmed list. Missing/private/unusable values remain review-only at panel creation.
-   Source `85b3970` pushed as NumberSixDev and deployed via the existing Mac LaunchAgent. Build/all95 tests, formatting/lint, configuration and performance checks passed. Fault/guard cases and a60-target virtual timing test pass; the production timer measured1002ms and1001ms between mocked sends. The restarted runtime connected and verified115 guild members plus the guild-kick help entry. No real kick was issued; live server removal/cooldown behaviour is untested.

## Historical implementation and verification

11 November follow-up: shared player-stat refresh stalls now have independent
deadlines and retry recovery. Purge preview stops waiting after20 seconds and
edits its deferred response with a clear failure; late snapshots cannot create
a panel or issue kicks. Regression coverage passes. Release details are in
ASTRA_HANDOFF.md; existing freshness, exclusions and confirmation checks remain.

Updated 10 November 2026. Owner: Astra. Status: purge, permanent exclusions and staff-channel restriction pushed/deployed. Ben confirmed the purge panel works; all74 offline tests pass.

## Target and authority

-   Existing Mac checkout `/Users/ben/Documents/ChatGPT/Guild Bridge`, branch `feat/dragsim-guild-chat`. origin NumberSixDev/bridge, upstream MiscGuild/bridge. NumberSixDev identity verified. Ben authorises commit/push and restart of the existing LaunchAgent. Do not use Fixerq, change startup/sleep/billing or create a second Minecraft login.
-   Ben requested the feature, including its Discord confirmation step. Agents must not run a real purge to test it. Real removal requires an authorised user to confirm the exact target list in Discord.
-   Credentials, authentication, caches and exclusions remain local/ignored. No dependencies added.

## Implemented decisions

-   `/purge` opens a panel only in `STAFF_COMMAND_CHANNEL_ID`. Only the existing configured Admin/Guild Master roles can operate any control; fresh role checks are reused from recruitment, without owner/staff bypasses or duplicate pre-acknowledgement lookups.
-   Uses both saved recruitment minimums, independent of auto-accept. A member failing either minimum is a candidate. Equality meets a minimum. Each row shows networth and purse ticks/crosses and compact amounts; unavailable/private data is review-only.
-   25 complete rows/page and a matching paginated dropdown. Selecting a name toggles exclusion/reinclusion. Saved exclusions persist in ignored `.bridge-data/purge.json`, scoped to the configured Discord guild, bounded, atomic and private. Concurrent writes are serialized; storage errors disable purge.
-   Ben explicitly selected using the displayed networth estimates, including partial values. Root set local `PURGE_ALLOW_PARTIAL_NETWORTH=true`; template defaults false. Recruitment auto-admission quality rules are unchanged. Fresh API retrieval/calculation is required for kicks; an offline profile's last save time is not misrepresented as a new save.
-   Protect the bot and the Guild Master. Other ranks are subject to requirements unless excluded. A read-only `/g help` probe must verify the kick syntax on the existing connection before the red Purge button can operate.
-   Permanent exclusions shipped in `12cef7a`: local `PURGE_PROTECTED_USERNAMES` contains LabGeek2, LabGeek, fcxxv and DragSim. Case-insensitive guards hide them from all purge rows and reject them at preflight, execution and immediately before dispatch. Dropdown controls cannot re-include them. The old live panel was cleared/disabled. Read-only local checks of the live configuration verified all four hidden and blocked; no kicks were sent.
-   Staff-channel update: `/command`, `/slowmode`, `/terminate`, `/recruitment` and `/purge` are restricted to `1569792569418977330`, including old management buttons, modals and selectors. Purge rechecks the channel during execution. Existing roles remain required. Application Accept/Deny cards retain their separate application channel and existing scope/role checks; public commands remain public.
-   Red Purge performs a bounded fresh roster/API preflight, then displays a frozen, paginated target list. The final confirmation has an actor-bound, one-use nonce and independent two-minute expiry. Old/replaced/duplicate buttons cannot confirm a different set. Requirement/exclusion changes invalidate it. Newly qualifying or newly joined members cannot be added silently.
-   A single sequential job re-fetches each player's evidence and rechecks current authority/settings/exclusions/readiness immediately before dispatch. Disconnect or shutdown cancels continuity. After each kick it verifies removal with a fresh complete roster; unconfirmed removal stops the remaining batch. No retries or automatic restart of destructive work. Completed panels cannot start another job.
-   Existing guild chat, recruitment settings and all leaderboard commands remain intact.

## Verification

-   `pnpm test`: TypeScript build and all67 tests pass. Formatting/lint, configuration validation and diff whitespace pass.
-   Regression coverage includes either/both/equality comparisons, partial policy/privacy/freshness, page/select bounds, persisted exclusions, concurrent selections, corruption/write failure, denied roles, wrong actor/channel/expired controls, stale nonces, duplicate confirmation, changed requirements/exclusions/roles during fresh lookup, newly compliant members, frozen membership, disconnect/shutdown, successful verified removal and stop after an unconfirmed command.
-   Coordinator ended at its time cap. Root resolved build/lint failures, completed the focused safety review and added the concurrency/replay/authority regression cases. No worker remains active.
-   Source revision `7266ded` is pushed to origin and deployed via the existing Mac LaunchAgent. Discord API confirms `/purge` is registered. The bot reconnected and verified the server help entry `/guild kick <player>` on its existing Minecraft connection.
-   A read-only live lookup of a below-minimum player passed the fresh purge evaluator using the explicitly approved partial-networth policy. The requesting user currently has an allowed configured Discord role. No real kick was issued.
-   Ben's first `/purge` attempt exposed a roster-parser failure. A targeted runtime diagnostic found an observed trailing `♲` profile icon after a username; the parser had rejected its whole list line. Fix `c957ce7` strips only that observed display suffix, retains strict usernames/counts/spoof rejection, and is pushed/deployed. The new runtime verified all87 guild members and the `/guild kick` help entry. All67 tests, formatting/lint and configuration checks still pass. Temporary diagnostics were removed.
-   Ben retried `/purge` and confirmed the panel works. Real removals and the bot's kick permission require the authorised user's explicit final confirmation; neither is claimed tested live.
-   Staff-channel checks: build and all74 offline tests pass, including owner/role-bearing command denial outside the channel, old settings/purge controls, separate application reviews, public commands, channel configuration and purge service guards.
-   Staff-channel source `dc4ba19` pushed as NumberSixDev and remote SHA verified. Formatting/lint and local configuration pass. Discord readback confirms the configured staff channel belongs to the correct guild; the deployed configuration accepts that channel and rejects guild-chat/application channels for management commands. Existing LaunchAgent restarted at22:13UTC, reconnected LabGeek2 and verified all87 members plus kick capability. Actual user clicks under the new channel restriction have not yet been observed; no agent issued a real kick.
