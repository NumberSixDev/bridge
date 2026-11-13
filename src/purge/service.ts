import BridgeEmbed from '@discord/embed';
/* eslint-disable class-methods-use-this, no-constant-condition */
/* eslint-disable no-await-in-loop, no-restricted-syntax, no-nested-ternary */

import { randomUUID } from 'node:crypto';
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ChatInputCommandInteraction,
    escapeMarkdown,
    InteractionEditReplyOptions,
    StringSelectMenuBuilder,
    StringSelectMenuInteraction,
    StringSelectMenuOptionBuilder,
} from 'discord.js';
import path from 'node:path';
import winston from 'winston';
import env from '@util/env';
import isStaffCommandChannel from '@util/staff-command-channel';
import withTimeout from '@util/with-timeout';
import { formatAmount } from '../recruitment/amount';
import { RecruitmentSettings } from '../recruitment/types';
import {
    FreshPurgeEvidence,
    GuildRoster,
    LeaderboardDataset,
    LeaderboardPurgeSnapshot,
} from '../leaderboard/types';
import { isValidMinecraftUsername } from '../leaderboard/roster';
import { parseKickCapabilityHelpLine, GuildKickSyntax } from './capability';
import { FilePurgeStore } from './store';
import { PurgeBaseStatus, PurgeExclusionStore, PurgeRow, PurgeRowStatus } from './types';

const PAGE_SIZE = 25;
const SESSION_TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 100;
const MAX_DATA_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const CONFIRMATION_TTL_MS = 2 * 60_000;
const PROBE_TIMEOUT_MS = 8_000;
const JOB_TIMEOUT_MS = 5 * 60_000;
const KICK_INTERVAL_MS = 1_000;
const BUTTON_PATTERN =
    /^purge:([A-Za-z0-9_-]{1,80}):(prev|next|open|confirm|cancel|confirm-prev|confirm-next)(?::([A-Za-z0-9_-]{1,80}))?$/;
const SELECT_PATTERN = /^purge:([A-Za-z0-9_-]{1,80}):select$/;

export type PurgeInteraction =
    | ChatInputCommandInteraction
    | ButtonInteraction<'cached'>
    | StringSelectMenuInteraction<'cached'>;

export interface PurgeFreshEvaluation {
    eligible: boolean;
    reviewOnly: boolean;
    reason: string;
    networth?: number;
    purse?: number;
    approximate?: boolean;
}

export interface PurgeServiceOptions {
    getSettings: () => RecruitmentSettings;
    authoriseInteraction: (interaction: PurgeInteraction) => Promise<boolean>;
    getSnapshot: (forceRoster?: boolean) => Promise<LeaderboardPurgeSnapshot>;
    isMinecraftReady: () => boolean;
    getBotUsername: () => string | undefined;
    sendMinecraftCommand: (command: string) => void;
    store?: PurgeExclusionStore;
    dataDir?: string;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    snapshotTimeoutMs?: number;
}

interface FrozenTarget {
    username: string;
    networth: number;
    purse: number;
    approximate: boolean;
    checkedAt: number;
}

interface PendingConfirmation {
    nonce: string;
    expiresAt: number;
    actorId: string;
    targets: FrozenTarget[];
    settingsRevision: number;
    minimumNetworth: number;
    minimumPurse: number;
    exclusionsRevision: number;
    page: number;
}

interface PurgeSession {
    id: string;
    guildId: string;
    channelId: string;
    messageId: string;
    createdBy: string;
    expiresAt: number;
    settingsRevision: number;
    minimumNetworth: number;
    minimumPurse: number;
    exclusionsRevision: number;
    rosterObservedAt: number;
    guildMaster?: string;
    datasetCompletedAt: number;
    baseRows: PurgeRow[];
    rows: PurgeRow[];
    page: number;
    notice?: string;
    pending?: PendingConfirmation;
    hasRun?: boolean;
}

interface ActiveJob {
    sessionId: string;
    nonce: string;
    generation: number;
    startedAt: number;
}

interface PurgeCounts {
    sent: number;
    skipped: number;
    failed: number;
    stopReason?: string;
}

function finiteAmount(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= Number.MAX_SAFE_INTEGER
    );
}

function sameUsername(left: string | undefined, right: string | undefined) {
    return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function permanentlyExcluded(username: string) {
    return env.PURGE_PROTECTED_USERNAMES.some((name) => sameUsername(name, username));
}

function ageIssue(label: string, value: number | undefined, now: number) {
    if (value === undefined || !Number.isFinite(value)) return `${label} timestamp is missing.`;
    if (value - now > MAX_FUTURE_SKEW_MS) return `${label} timestamp is from the future.`;
    if (now - value > MAX_DATA_AGE_MS) return `${label} data is older than 5 minutes.`;
    return undefined;
}

function statusRank(status: PurgeRowStatus) {
    return { eligible: 0, review: 1, protected: 2, excluded: 3 }[status];
}

function rowValue(value: number | undefined, minimum: number, approximate = false) {
    if (!finiteAmount(value)) return '❔ unavailable';
    return `${value >= minimum ? '✅' : '❌'}${approximate ? '≈' : ''}${formatAmount(value)}`;
}

function rowStatus(status: PurgeRowStatus) {
    switch (status) {
        case 'eligible':
            return 'Ready';
        case 'excluded':
            return 'Excluded';
        case 'protected':
            return 'Protected';
        default:
            return 'Review only';
    }
}

function settingRevision(settings: RecruitmentSettings) {
    return settings.revision ?? 0;
}

function validSettings(settings: RecruitmentSettings): settings is RecruitmentSettings & {
    minimumNetworth: number;
    minimumPurse: number;
} {
    return finiteAmount(settings.minimumNetworth) && finiteAmount(settings.minimumPurse);
}

function currentExclusionSet(excluded: Iterable<string>) {
    const usernames = [...excluded];
    if (usernames.length > 500) throw new Error('Too many purge exclusions.');
    if (!usernames.every((username) => isValidMinecraftUsername(username)))
        throw new Error('Purge exclusions contain an invalid Minecraft username.');
    const keys = new Set(usernames.map((username) => username.toLowerCase()));
    if (keys.size !== usernames.length) throw new Error('Purge exclusions contain duplicates.');
    return keys;
}

function recordValue(dataset: LeaderboardDataset, username: string, key: string) {
    return dataset.records.find((record) => sameUsername(record.username, username))?.values?.[key];
}

function recordFor(dataset: LeaderboardDataset, username: string) {
    return dataset.records.find((record) => sameUsername(record.username, username));
}

export function buildPurgeRows(
    roster: GuildRoster,
    dataset: LeaderboardDataset,
    settings: RecruitmentSettings,
    excluded: Iterable<string>,
    botUsername: string | undefined,
    now: number
) {
    if (!validSettings(settings)) return [];
    const exclusions = currentExclusionSet(excluded);
    const datasetAge = now - dataset.completedAt;
    const datasetIssue =
        datasetAge < -MAX_FUTURE_SKEW_MS
            ? 'The leaderboard dataset timestamp is from the future.'
            : datasetAge > 15 * 60_000
            ? 'The leaderboard dataset is older than 15 minutes.'
            : !dataset.includesNetworth
            ? 'Networth data is not available in the completed dataset.'
            : undefined;

    const rows: PurgeRow[] = [];
    for (const username of roster.members) {
        if (permanentlyExcluded(username)) continue;
        const record = recordFor(dataset, username);
        const networth = recordValue(dataset, username, 'networth');
        const purse = recordValue(dataset, username, 'purse');
        const approximate = record?.approximate?.networth === true;
        const issues: string[] = [];
        if (datasetIssue) issues.push(datasetIssue);
        if (!record) issues.push('No current verified profile data is available.');
        if (!finiteAmount(networth)) issues.push('Networth is unavailable.');
        if (!finiteAmount(purse)) issues.push('Purse is unavailable.');
        if (approximate && !env.PURGE_ALLOW_PARTIAL_NETWORTH)
            issues.push('The networth valuation is incomplete; manual review is required.');

        const belowMinimum =
            finiteAmount(networth) && finiteAmount(purse)
                ? networth < settings.minimumNetworth || purse < settings.minimumPurse
                : true;
        if (!issues.length && !belowMinimum) continue;

        const isGuildMaster = sameUsername(roster.guildMaster, username);
        const isBot = sameUsername(botUsername, username);
        const protectedReason = isGuildMaster
            ? 'Guild Master is protected.'
            : isBot
            ? 'The bridge account is protected.'
            : undefined;
        const baseStatus: PurgeBaseStatus = protectedReason
            ? 'protected'
            : issues.length
            ? 'review'
            : 'eligible';
        const reason = [...issues, protectedReason].filter(Boolean).join(' ');
        const status: PurgeRowStatus =
            baseStatus === 'protected'
                ? 'protected'
                : exclusions.has(username.toLowerCase())
                ? 'excluded'
                : baseStatus;
        rows.push({
            username,
            status,
            baseStatus,
            networth: finiteAmount(networth) ? networth : undefined,
            purse: finiteAmount(purse) ? purse : undefined,
            networthApproximate: approximate,
            dataAgeMs: Math.max(0, now - (record?.profileObservedAt ?? dataset.completedAt)),
            reason: reason || 'Below at least one configured minimum.',
        });
    }
    return rows.sort(
        (left, right) =>
            statusRank(left.status) - statusRank(right.status) ||
            left.username.toLowerCase().localeCompare(right.username.toLowerCase())
    );
}

export function evaluateFreshPurgeEvidence(
    username: string,
    evidence: FreshPurgeEvidence,
    settings: RecruitmentSettings,
    now: number
): PurgeFreshEvaluation {
    if (permanentlyExcluded(username))
        return {
            eligible: false,
            reviewOnly: false,
            reason: 'This player is permanently excluded from purge.',
        };
    if (!validSettings(settings)) {
        return {
            eligible: false,
            reviewOnly: true,
            reason: 'Both recruitment minimums must be set before purge can run.',
        };
    }
    if (!evidence?.profile || !evidence.networth) {
        return {
            eligible: false,
            reviewOnly: true,
            reason: 'Profile or networth evidence is missing.',
        };
    }
    const issues: string[] = [];
    const { profile, networth } = evidence;
    if (!isValidMinecraftUsername(username) || !profile.uuid || !profile.profileId)
        issues.push('Player or profile identity is missing or invalid.');
    if (
        typeof profile.inventoryHidden !== 'boolean' ||
        typeof networth.hidden !== 'boolean' ||
        typeof networth.partial !== 'boolean'
    )
        issues.push('Privacy or valuation status is missing.');
    if (!sameUsername(profile.username, username))
        issues.push('The profile API returned a different player identity.');
    if (!sameUsername(networth.username, username))
        issues.push('The networth API returned a different player identity.');
    if (networth.profileId !== profile.profileId)
        issues.push('The networth API returned a different profile identity.');
    if (profile.inventoryHidden) issues.push('The profile inventory is private.');
    if (networth.hidden) issues.push('The networth valuation is private.');
    const purse =
        profile.profile && typeof profile.profile === 'object'
            ? (profile.profile as Record<string, unknown>).coins
            : undefined;
    if (!finiteAmount(purse)) issues.push('Purse is missing or not finite.');
    if (!finiteAmount(networth.total)) issues.push('Networth is missing or not finite.');
    if (networth.partial && !env.PURGE_ALLOW_PARTIAL_NETWORTH)
        issues.push('The networth valuation is incomplete; manual review is required.');
    for (const [label, timestamp] of [
        ['Profile retrieval', profile.observedAt],
        ['Networth retrieval', networth.observedAt],
        ['Networth calculation', networth.calculatedAt],
    ] as const) {
        const issue = ageIssue(label, timestamp, now);
        if (issue) issues.push(issue);
    }
    if (profile.profileSavedAt !== undefined && profile.profileSavedAt - now > MAX_FUTURE_SKEW_MS)
        issues.push('Profile save timestamp is from the future.');
    if (
        networth.marketObservedAt !== undefined &&
        ageIssue('Market', networth.marketObservedAt, now)
    )
        issues.push(ageIssue('Market', networth.marketObservedAt, now)!);
    const networthValue = finiteAmount(networth.total) ? networth.total : undefined;
    const purseValue = finiteAmount(purse) ? purse : undefined;
    if (issues.length || networthValue === undefined || purseValue === undefined) {
        return {
            eligible: false,
            reviewOnly: true,
            reason: issues.join(' '),
            networth: networthValue,
            purse: purseValue,
            approximate: networth.partial,
        };
    }
    const below = networthValue < settings.minimumNetworth || purseValue < settings.minimumPurse;
    return {
        eligible: below,
        reviewOnly: false,
        reason: below
            ? 'Fresh public evidence still fails at least one recruitment minimum.'
            : 'Fresh public evidence meets both recruitment minimums; skipped.',
        networth: networthValue,
        purse: purseValue,
        approximate: networth.partial,
    };
}

function applyExclusions(rows: PurgeRow[], excluded: Set<string>): PurgeRow[] {
    return rows.map((row) => ({
        ...row,
        status:
            row.baseStatus === 'protected'
                ? 'protected'
                : excluded.has(row.username.toLowerCase())
                ? 'excluded'
                : row.baseStatus,
    })) as PurgeRow[];
}

function pageCount(items: Array<unknown>) {
    return Math.max(1, Math.ceil(items.length / PAGE_SIZE));
}

function messageId(reply: unknown) {
    return reply && typeof reply === 'object' && 'id' in reply && typeof reply.id === 'string'
        ? reply.id
        : undefined;
}

function formatAge(ageMs: number) {
    const seconds = Math.max(0, Math.floor(ageMs / 1_000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
}

export default class PurgeService {
    private readonly getSettings: () => RecruitmentSettings;
    private readonly authorise: (interaction: PurgeInteraction) => Promise<boolean>;
    private readonly snapshotTimeoutMs: number;
    private readonly getSnapshot: (forceRoster?: boolean) => Promise<LeaderboardPurgeSnapshot>;
    private readonly isMinecraftReady: () => boolean;
    private readonly getBotUsername: () => string | undefined;
    private readonly sendMinecraftCommand: (command: string) => void;
    private readonly store: PurgeExclusionStore;
    private readonly now: () => number;
    private readonly sleep: (milliseconds: number) => Promise<void>;
    private readonly sessions = new Map<string, PurgeSession>();
    private excluded = new Set<string>();
    private exclusionsRevision = 0;
    private storageIssue?: string;
    private stopped = false;
    private lifecycleGeneration = 0;
    private kickSyntax?: GuildKickSyntax;
    private probeTimer?: ReturnType<typeof setTimeout>;
    private activeJob?: ActiveJob;
    private preparing = false;
    private exclusionWrites = 0;
    private exclusionQueue: Promise<void> = Promise.resolve();

    public constructor(options: PurgeServiceOptions) {
        this.snapshotTimeoutMs = options.snapshotTimeoutMs ?? 20_000;
        this.getSettings = options.getSettings;
        this.authorise = async (interaction) =>
            isStaffCommandChannel(interaction) && options.authoriseInteraction(interaction);
        this.getSnapshot = options.getSnapshot;
        this.isMinecraftReady = options.isMinecraftReady;
        this.getBotUsername = options.getBotUsername;
        this.sendMinecraftCommand = options.sendMinecraftCommand;
        this.store =
            options.store ??
            new FilePurgeStore(
                path.resolve(options.dataDir ?? env.RECRUITMENT_DATA_DIR, 'purge.json')
            );
        this.now = options.now ?? Date.now;
        this.sleep =
            options.sleep ??
            ((milliseconds) =>
                new Promise((resolve) => {
                    setTimeout(resolve, milliseconds);
                }));
        try {
            this.excluded = currentExclusionSet(this.store.load(env.DISCORD_SERVER_ID));
        } catch (error) {
            this.storageIssue =
                error instanceof Error ? error.message : 'Purge exclusions could not be loaded.';
            winston.error(`Purge storage unavailable: ${this.storageIssue}`);
        }
    }

    public get storageError() {
        return this.storageIssue;
    }

    public get kickCapability() {
        return this.kickSyntax;
    }

    public get exclusions() {
        return [...this.excluded];
    }

    public ownsInteraction(interaction: { customId?: string }) {
        return (
            typeof interaction.customId === 'string' && interaction.customId.startsWith('purge:')
        );
    }

    public authoriseInteraction(interaction: PurgeInteraction) {
        return this.authorise(interaction);
    }

    public async onMinecraftReady() {
        if (this.stopped) return;
        this.lifecycleGeneration += 1;
        this.kickSyntax = undefined;
        clearTimeout(this.probeTimer);
        this.probeTimer = undefined;
        const generation = this.lifecycleGeneration;
        this.probeTimer = setTimeout(() => {
            if (generation !== this.lifecycleGeneration || this.kickSyntax) return;
            this.probeTimer = undefined;
            winston.warn('Purge remains disabled: no verified guild kick help entry was observed.');
        }, PROBE_TIMEOUT_MS);
        this.probeTimer.unref();
        try {
            this.sendMinecraftCommand('/g help');
        } catch (error) {
            clearTimeout(this.probeTimer);
            this.probeTimer = undefined;
            winston.warn(
                `Purge capability probe could not start: ${
                    error instanceof Error ? error.message : error
                }`
            );
        }
    }

    public handleMinecraftMessage(message: string) {
        if (!this.probeTimer || this.kickSyntax || typeof message !== 'string') return;
        for (const line of message.split(/\r?\n/u)) {
            const syntax = parseKickCapabilityHelpLine(line);
            if (!syntax) continue;
            this.kickSyntax = syntax;
            clearTimeout(this.probeTimer);
            this.probeTimer = undefined;
            winston.info(`Verified guild purge capability: /${syntax} kick <player>.`);
            return;
        }
    }

    public onMinecraftDisconnected() {
        this.lifecycleGeneration += 1;
        this.kickSyntax = undefined;
        clearTimeout(this.probeTimer);
        this.probeTimer = undefined;
        for (const session of this.sessions.values()) session.pending = undefined;
    }

    public stop() {
        this.stopped = true;
        this.lifecycleGeneration += 1;
        clearTimeout(this.probeTimer);
        this.probeTimer = undefined;
        this.kickSyntax = undefined;
        this.sessions.clear();
    }

    public async handleCommand(interaction: ChatInputCommandInteraction) {
        if (!(await this.authorise(interaction))) {
            await interaction.reply({
                content: 'You do not have permission to use purge controls.',
                ephemeral: true,
            });
            return;
        }
        if (this.storageIssue) {
            await interaction.reply({ content: this.storageMessage(), ephemeral: true });
            return;
        }
        if (this.stopped) {
            await interaction.reply({ content: 'Purge is stopped.', ephemeral: true });
            return;
        }
        const settings = this.getSettings();
        await interaction.deferReply();
        if (!validSettings(settings)) {
            await interaction.editReply(
                this.disabledPayload('Set both recruitment minimums before opening purge.')
            );
            return;
        }
        let snapshot: LeaderboardPurgeSnapshot;
        try {
            snapshot = await withTimeout(
                this.getSnapshot(true),
                this.snapshotTimeoutMs,
                'Player stats are still refreshing. Please try /purge again shortly.'
            );
        } catch (error) {
            await interaction.editReply({
                content: `Purge could not load a verified guild snapshot: ${
                    error instanceof Error ? error.message : 'please try again shortly.'
                }`,
                components: [],
            });
            return;
        }
        const baseRows = buildPurgeRows(
            snapshot.roster,
            snapshot.dataset,
            settings,
            [],
            this.getBotUsername(),
            this.now()
        );
        const session: PurgeSession = {
            id: randomUUID(),
            guildId: env.DISCORD_SERVER_ID,
            channelId: interaction.channelId,
            messageId: '',
            createdBy: interaction.user.id,
            expiresAt: this.now() + SESSION_TTL_MS,
            settingsRevision: settingRevision(settings),
            minimumNetworth: settings.minimumNetworth,
            minimumPurse: settings.minimumPurse,
            exclusionsRevision: this.exclusionsRevision,
            rosterObservedAt: snapshot.roster.observedAt,
            guildMaster: snapshot.roster.guildMaster,
            datasetCompletedAt: snapshot.dataset.completedAt,
            baseRows,
            rows: applyExclusions(baseRows, this.excluded),
            page: 0,
        };
        this.sessions.set(session.id, session);
        this.pruneSessions();
        const reply = await interaction.editReply(this.panelPayload(session));
        const replyId = messageId(reply) ?? (await this.fetchReplyId(interaction));
        if (replyId) session.messageId = replyId;
        else this.sessions.delete(session.id);
    }

    public async handleInteraction(
        interaction: ButtonInteraction<'cached'> | StringSelectMenuInteraction<'cached'>
    ) {
        if (!(await this.authorise(interaction))) {
            await interaction.reply({
                content: 'You do not have permission to use purge controls.',
                ephemeral: true,
            });
            return;
        }
        if (this.storageIssue) {
            await interaction.reply({ content: this.storageMessage(), ephemeral: true });
            return;
        }
        if (
            typeof interaction.isStringSelectMenu === 'function' &&
            interaction.isStringSelectMenu()
        ) {
            await this.handleSelect(interaction);
            return;
        }
        await this.handleButton(interaction as ButtonInteraction<'cached'>);
    }

    private async handleSelect(interaction: StringSelectMenuInteraction<'cached'>) {
        await interaction.deferUpdate();
        this.exclusionWrites += 1;
        const update = this.exclusionQueue.then(() => this.changeExclusion(interaction));
        this.exclusionQueue = update.catch(() => undefined);
        try {
            await update;
        } finally {
            this.exclusionWrites -= 1;
        }
    }

    private async changeExclusion(interaction: StringSelectMenuInteraction<'cached'>) {
        if (this.storageIssue || this.stopped) {
            await interaction.followUp({
                content: 'Purge storage is unavailable or the service stopped.',
                ephemeral: true,
            });
            return;
        }
        const match = interaction.customId.match(SELECT_PATTERN);
        if (!match?.[1] || interaction.values.length !== 1) {
            await interaction.followUp({
                content: 'That purge selector is not recognised.',
                ephemeral: true,
            });
            return;
        }
        const session = this.validSession(interaction, match[1]);
        if (!session) {
            await interaction.followUp({
                content: 'That purge panel has expired or is out of scope.',
                ephemeral: true,
            });
            return;
        }
        this.syncSession(session);
        const username = interaction.values[0]!;
        const pageRows = this.pageRows(session.rows, session.page);
        if (!pageRows.some((row) => sameUsername(row.username, username))) {
            await interaction.followUp({
                content: 'Choose a player visible on the current purge page.',
                ephemeral: true,
            });
            return;
        }
        const next = new Set(this.excluded);
        const key = username.toLowerCase();
        if (next.has(key)) next.delete(key);
        else next.add(key);
        try {
            await this.store.save(env.DISCORD_SERVER_ID, [...next]);
            this.excluded = next;
            this.exclusionsRevision += 1;
            session.notice = undefined;
            this.syncSession(session);
            await interaction.editReply(this.panelPayload(session));
        } catch (error) {
            this.storageIssue =
                error instanceof Error ? error.message : 'Exclusion storage failed.';
            this.exclusionsRevision += 1;
            for (const entry of this.sessions.values()) entry.pending = undefined;
            session.notice = undefined;
            await interaction.followUp({
                content: `The exclusion was not saved: ${
                    error instanceof Error ? error.message : 'storage failed.'
                }`,
                ephemeral: true,
            });
        }
    }

    private async handleButton(interaction: ButtonInteraction<'cached'>) {
        const match = interaction.customId.match(BUTTON_PATTERN);
        await interaction.deferUpdate();
        if (!match?.[1] || !match[2]) {
            await interaction.followUp({
                content: 'That purge control is not recognised.',
                ephemeral: true,
            });
            return;
        }
        const session = this.validSession(interaction, match[1]);
        if (!session) {
            await interaction.followUp({
                content: 'That purge panel has expired or is out of scope.',
                ephemeral: true,
            });
            return;
        }
        this.syncSession(session);
        if (match[2] === 'confirm' || match[2] === 'cancel' || match[2].startsWith('confirm-')) {
            if (
                !session.pending ||
                match[3] !== session.pending.nonce ||
                session.pending.expiresAt <= this.now()
            ) {
                await interaction.followUp({
                    content: 'That confirmation has expired or was replaced. Press Purge again.',
                    ephemeral: true,
                });
                return;
            }
        }
        switch (match[2]) {
            case 'prev':
                session.page = Math.max(0, session.page - 1);
                await interaction.editReply(this.panelPayload(session));
                return;
            case 'next':
                session.page = Math.min(pageCount(session.rows) - 1, session.page + 1);
                await interaction.editReply(this.panelPayload(session));
                return;
            case 'open':
                await this.prepareConfirmation(session, interaction);
                return;
            case 'confirm-prev':
                if (session.pending) session.pending.page = Math.max(0, session.pending.page - 1);
                await interaction.editReply(this.confirmationPayload(session));
                return;
            case 'confirm-next':
                if (session.pending)
                    session.pending.page = Math.min(
                        pageCount(session.pending.targets) - 1,
                        session.pending.page + 1
                    );
                await interaction.editReply(this.confirmationPayload(session));
                return;
            case 'cancel':
                session.pending = undefined;
                session.notice = 'Purge cancelled. No Minecraft command was sent.';
                await interaction.editReply(this.panelPayload(session));
                return;
            case 'confirm':
                await this.confirm(session, interaction);
                return;
            default:
                await interaction.followUp({
                    content: 'That purge control is not recognised.',
                    ephemeral: true,
                });
        }
    }

    private async prepareConfirmation(
        session: PurgeSession,
        interaction: ButtonInteraction<'cached'>
    ) {
        if (this.preparing || session.hasRun || this.exclusionWrites || this.storageIssue) {
            await interaction.followUp({
                content:
                    'A purge check or exclusion update is in progress, or this panel has already run. Use a fresh /purge panel when it finishes.',
                ephemeral: true,
            });
            return;
        }
        this.preparing = true;
        session.pending = undefined;
        try {
            await this.collectConfirmation(session, interaction);
        } finally {
            this.preparing = false;
        }
    }

    private async collectConfirmation(
        session: PurgeSession,
        interaction: ButtonInteraction<'cached'>
    ) {
        const settings = this.getSettings();
        if (!validSettings(settings) || !this.sessionSettingsCurrent(session)) {
            session.notice = 'Recruitment minimums changed. Run /purge again before confirming.';
            await interaction.editReply(this.panelPayload(session));
            return;
        }
        if (!this.kickSyntax) {
            session.notice = this.capabilityMessage();
            await interaction.editReply(this.panelPayload(session));
            return;
        }
        if (!isValidMinecraftUsername(this.getBotUsername() ?? '')) {
            session.notice = 'Purge is disabled until the bridge account identity is available.';
            await interaction.editReply(this.panelPayload(session));
            return;
        }
        if (this.activeJob) {
            session.notice = 'Another purge job is already running.';
            await interaction.editReply(this.panelPayload(session));
            return;
        }
        // Freeze the reviewed values. Confirmation and execution must not refetch
        // player evidence or silently change the administrator's selected list.
        this.syncSession(session);
        const targets = session.rows.flatMap((row): FrozenTarget[] => {
            if (
                row.baseStatus !== 'eligible' ||
                row.status === 'excluded' ||
                !isValidMinecraftUsername(row.username) ||
                permanentlyExcluded(row.username) ||
                this.excluded.has(row.username.toLowerCase()) ||
                sameUsername(session.guildMaster, row.username) ||
                sameUsername(this.getBotUsername(), row.username) ||
                !finiteAmount(row.networth) ||
                !finiteAmount(row.purse)
            )
                return [];
            return [
                {
                    username: row.username,
                    networth: row.networth,
                    purse: row.purse,
                    approximate: row.networthApproximate === true,
                    checkedAt: session.datasetCompletedAt,
                },
            ];
        });
        if (!targets.length) {
            session.notice = 'There are no eligible, non-excluded members in this review list.';
            await interaction.editReply(this.panelPayload(session));
            return;
        }
        session.notice = undefined;
        session.pending = {
            nonce: randomUUID(),
            expiresAt: this.now() + CONFIRMATION_TTL_MS,
            actorId: interaction.user.id,
            targets,
            settingsRevision: settingRevision(settings),
            minimumNetworth: settings.minimumNetworth,
            minimumPurse: settings.minimumPurse,
            exclusionsRevision: this.exclusionsRevision,
            page: 0,
        };
        session.expiresAt = this.now() + SESSION_TTL_MS;
        await interaction.editReply(this.confirmationPayload(session));
    }

    private async confirm(session: PurgeSession, interaction: ButtonInteraction<'cached'>) {
        const { pending } = session;
        if (!pending) {
            await interaction.followUp({
                content: 'This purge confirmation is no longer active.',
                ephemeral: true,
            });
            return;
        }
        if (pending.actorId !== interaction.user.id) {
            await interaction.followUp({
                content: 'Only the administrator who opened this confirmation can confirm it.',
                ephemeral: true,
            });
            return;
        }
        const settings = this.getSettings();
        if (
            pending.expiresAt <= this.now() ||
            this.exclusionWrites ||
            this.storageIssue ||
            !validSettings(settings) ||
            settingRevision(settings) !== pending.settingsRevision ||
            settings.minimumNetworth !== pending.minimumNetworth ||
            settings.minimumPurse !== pending.minimumPurse ||
            this.exclusionsRevision !== pending.exclusionsRevision
        ) {
            session.pending = undefined;
            session.notice =
                'Requirements or exclusions changed. No Minecraft command was sent; run /purge again.';
            await interaction.editReply(this.panelPayload(session));
            return;
        }
        if (this.activeJob) {
            await interaction.followUp({
                content: 'Another purge job is already running.',
                ephemeral: true,
            });
            return;
        }
        if (
            !this.kickSyntax ||
            !this.isMinecraftReady() ||
            !isValidMinecraftUsername(this.getBotUsername() ?? '')
        ) {
            session.pending = undefined;
            session.notice =
                'Purge is disabled because the Minecraft connection or verified kick capability is unavailable.';
            await interaction.editReply(this.panelPayload(session));
            return;
        }
        const job: ActiveJob = {
            sessionId: session.id,
            nonce: pending.nonce,
            generation: this.lifecycleGeneration,
            startedAt: this.now(),
        };
        this.activeJob = job;
        session.pending = undefined;
        session.hasRun = true;
        session.notice =
            'Purge is running. No new members will be added to this frozen target set.';
        let counts: PurgeCounts;
        try {
            await interaction.editReply(this.panelPayload(session));
            counts = await this.executeJob(job, pending.targets, pending, session.guildMaster);
        } finally {
            if (this.activeJob === job) this.activeJob = undefined;
        }
        session.notice = `${this.jobSummary(counts)} Run /purge again for the current member list.`;
        session.expiresAt = this.now() + SESSION_TTL_MS;
        await interaction.editReply(this.panelPayload(session));
    }

    private async executeJob(
        job: ActiveJob,
        targets: FrozenTarget[],
        pending: PendingConfirmation,
        guildMaster?: string
    ): Promise<PurgeCounts> {
        const counts: PurgeCounts = { sent: 0, skipped: 0, failed: 0 };
        const deadline =
            job.startedAt + Math.max(JOB_TIMEOUT_MS, targets.length * KICK_INTERVAL_MS + 30_000);
        let lastSentAt: number | undefined;
        for (const target of targets) {
            if (
                !isValidMinecraftUsername(target.username) ||
                permanentlyExcluded(target.username) ||
                sameUsername(guildMaster, target.username) ||
                sameUsername(this.getBotUsername(), target.username) ||
                this.excluded.has(target.username.toLowerCase())
            ) {
                counts.skipped += 1;
                continue;
            }
            if (lastSentAt !== undefined) {
                const remaining = Math.min(
                    KICK_INTERVAL_MS,
                    Math.max(0, KICK_INTERVAL_MS - (this.now() - lastSentAt))
                );
                if (remaining > 0) await this.sleep(remaining);
            }
            if (this.now() > deadline) {
                counts.stopReason = 'The bounded purge time limit was reached.';
                break;
            }
            // Roles were freshly checked on the confirmation interaction. These
            // local guards remain immediate; no network calls sit between kicks.
            if (!this.jobCanContinue(job, pending) || !this.kickSyntax) {
                counts.stopReason = 'Settings, exclusions, connection or shutdown state changed.';
                break;
            }
            if (
                permanentlyExcluded(target.username) ||
                this.excluded.has(target.username.toLowerCase()) ||
                sameUsername(this.getBotUsername(), target.username)
            ) {
                counts.skipped += 1;
                continue;
            }
            try {
                this.sendMinecraftCommand(`/${this.kickSyntax} kick ${target.username}`);
                lastSentAt = this.now();
                counts.sent += 1;
            } catch (error) {
                counts.failed += 1;
                counts.stopReason = `Kick command could not be sent for ${target.username}: ${
                    error instanceof Error ? error.message : 'unknown error'
                }`;
                break;
            }
        }
        return counts;
    }

    private jobCanContinue(job: ActiveJob, pending: PendingConfirmation) {
        const settings = this.getSettings();
        return (
            !this.stopped &&
            !this.storageIssue &&
            this.exclusionWrites === 0 &&
            this.activeJob === job &&
            this.lifecycleGeneration === job.generation &&
            this.isMinecraftReady() &&
            isValidMinecraftUsername(this.getBotUsername() ?? '') &&
            this.exclusionsRevision === pending.exclusionsRevision &&
            validSettings(settings) &&
            settingRevision(settings) === pending.settingsRevision &&
            settings.minimumNetworth === pending.minimumNetworth &&
            settings.minimumPurse === pending.minimumPurse
        );
    }

    private jobSummary(counts: PurgeCounts) {
        const suffix = counts.stopReason ? ` Stopped: ${counts.stopReason}` : '';
        return `Purge result: **${counts.sent} kick command(s) sent**, ${counts.skipped} skipped, ${counts.failed} send failures.${suffix}`;
    }

    private syncSession(session: PurgeSession) {
        if (session.exclusionsRevision === this.exclusionsRevision) return;
        session.rows = applyExclusions(session.baseRows, this.excluded);
        session.exclusionsRevision = this.exclusionsRevision;
        session.pending = undefined;
    }

    private sessionSettingsCurrent(session: PurgeSession) {
        const settings = this.getSettings();
        return (
            validSettings(settings) &&
            settingRevision(settings) === session.settingsRevision &&
            settings.minimumNetworth === session.minimumNetworth &&
            settings.minimumPurse === session.minimumPurse
        );
    }

    private validSession(
        interaction: ButtonInteraction<'cached'> | StringSelectMenuInteraction<'cached'>,
        sessionId: string
    ) {
        const session = this.sessions.get(sessionId);
        if (
            !session ||
            session.expiresAt <= this.now() ||
            interaction.guildId !== env.DISCORD_SERVER_ID ||
            interaction.guildId !== session.guildId ||
            interaction.channelId !== session.channelId ||
            interaction.message.id !== session.messageId ||
            interaction.message.guildId !== session.guildId
        )
            return undefined;
        session.expiresAt = this.now() + SESSION_TTL_MS;
        return session;
    }

    private pageRows(rows: PurgeRow[], page: number) {
        const bounded = Math.min(Math.max(page, 0), pageCount(rows) - 1);
        return rows.slice(bounded * PAGE_SIZE, (bounded + 1) * PAGE_SIZE);
    }

    private panelPayload(session: PurgeSession): InteractionEditReplyOptions {
        const rows = this.pageRows(session.rows, session.page);
        const pages = pageCount(session.rows);
        const settings = this.getSettings();
        const staleSettings = !this.sessionSettingsCurrent(session);
        const eligible = session.rows.filter((row) => row.status === 'eligible').length;
        const description = [
            `Showing **${session.rows.length}** guild members below a minimum or requiring review.`,
            `Thresholds: networth **${formatAmount(
                session.minimumNetworth
            )}**, purse **${formatAmount(session.minimumPurse)}**.`,
            `Preview data age: **${formatAge(this.now() - session.datasetCompletedAt)}**.`,
            session.notice,
            env.PURGE_ALLOW_PARTIAL_NETWORTH && rows.some((row) => row.networthApproximate === true)
                ? '≈ Partial networth estimates are shown; if confirmed, the purge uses those estimates.'
                : undefined,
            settings.autoAcceptEnabled
                ? 'Recruitment automatic acceptance being enabled does not change purge authority.'
                : undefined,
            '',
            rows.length
                ? rows
                      .map(
                          (row) =>
                              `**${escapeMarkdown(row.username)}** — NW ${rowValue(
                                  row.networth,
                                  session.minimumNetworth,
                                  row.networthApproximate
                              )} · Purse ${rowValue(
                                  row.purse,
                                  session.minimumPurse
                              )} · **${rowStatus(row.status)}**`
                      )
                      .join('\n')
                : 'No members currently need purge review.',
        ]
            .filter((line): line is string => line !== undefined)
            .join('\n');
        const limitedDescription =
            description.length > 4_090 ? `${description.slice(0, 4_087)}…` : description;
        const components = [];
        if (rows.length) {
            const select = new StringSelectMenuBuilder()
                .setCustomId(`purge:${session.id}:select`)
                .setPlaceholder('Exclude or re-include a player')
                .setMinValues(1)
                .setMaxValues(1)
                .addOptions(
                    rows.map((row) =>
                        new StringSelectMenuOptionBuilder()
                            .setLabel(row.username.slice(0, 100))
                            .setValue(row.username)
                            .setDescription(
                                `${
                                    row.status === 'excluded' ? 'Re-include' : 'Exclude'
                                } · ${rowStatus(row.status)}`.slice(0, 100)
                            )
                    )
                );
            components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
        }
        components.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`purge:${session.id}:prev`)
                    .setLabel('◀')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(session.page === 0),
                new ButtonBuilder()
                    .setCustomId(`purge:${session.id}:page`)
                    .setLabel(`Page ${Math.min(session.page + 1, pages)}/${pages}`)
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId(`purge:${session.id}:next`)
                    .setLabel('▶')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(session.page >= pages - 1)
            )
        );
        components.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`purge:${session.id}:open`)
                    .setLabel('Purge')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(
                        !eligible ||
                            !this.kickSyntax ||
                            !this.isMinecraftReady() ||
                            !isValidMinecraftUsername(this.getBotUsername() ?? '') ||
                            Boolean(this.activeJob) ||
                            Boolean(session.hasRun) ||
                            Boolean(this.storageIssue) ||
                            staleSettings ||
                            !validSettings(settings)
                    )
            )
        );
        return {
            embeds: [
                new BridgeEmbed()
                    .setColor('Red')
                    .setTitle('Guild purge review')
                    .setDescription(limitedDescription)
                    .setFooter({
                        text: `Page ${Math.min(
                            session.page + 1,
                            pages
                        )}/${pages} · Confirm before removing members.`,
                    }),
            ],
            components,
        };
    }

    private confirmationPayload(session: PurgeSession): InteractionEditReplyOptions {
        const { pending } = session;
        if (!pending) return this.panelPayload(session);
        const pages = pageCount(pending.targets);
        const page = Math.min(pending.page, pages - 1);
        pending.page = page;
        const targets = pending.targets.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        const description = [
            `This is a separate confirmation for **exactly ${pending.targets.length} frozen target(s)**.`,
            `Thresholds: networth **${formatAmount(
                pending.minimumNetworth
            )}**, purse **${formatAmount(pending.minimumPurse)}**.`,
            'Uses the values in the review panel. Sends one kick per second for this exact list.',
            pending.targets.some((target) => target.approximate)
                ? '≈ At least one target uses an explicitly allowed partial networth estimate.'
                : undefined,
            '',
            targets.map((target) => `• **${escapeMarkdown(target.username)}**`).join('\n'),
        ].join('\n');
        return {
            embeds: [
                new BridgeEmbed()
                    .setColor('Red')
                    .setTitle('Confirm guild purge')
                    .setDescription(
                        description.length > 4_090 ? `${description.slice(0, 4_087)}…` : description
                    )
                    .setFooter({
                        text: `Frozen target page ${page + 1}/${pages} · Nothing sent yet.`,
                    }),
            ],
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`purge:${session.id}:confirm-prev:${pending.nonce}`)
                        .setLabel('◀')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(page === 0),
                    new ButtonBuilder()
                        .setCustomId(`purge:${session.id}:confirm-page:${pending.nonce}`)
                        .setLabel(`Targets ${page + 1}/${pages}`)
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId(`purge:${session.id}:confirm-next:${pending.nonce}`)
                        .setLabel('▶')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(page >= pages - 1)
                ),
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`purge:${session.id}:confirm:${pending.nonce}`)
                        .setLabel('Confirm purge')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId(`purge:${session.id}:cancel:${pending.nonce}`)
                        .setLabel('Cancel')
                        .setStyle(ButtonStyle.Secondary)
                ),
            ],
        };
    }

    private disabledPayload(reason: string): InteractionEditReplyOptions {
        return {
            embeds: [
                new BridgeEmbed()
                    .setColor('Red')
                    .setTitle('Guild purge unavailable')
                    .setDescription(`${reason}\n\nNo Minecraft command was sent.`),
            ],
            components: [],
        };
    }

    private capabilityMessage() {
        return 'Purge is disabled until the server help output verifies `/g kick <player>` or `/guild kick <player>`.';
    }

    private storageMessage() {
        return `Purge exclusions are unavailable${
            this.storageIssue ? `: ${this.storageIssue}` : '.'
        } No purge action is enabled.`;
    }

    private async fetchReplyId(interaction: ChatInputCommandInteraction) {
        try {
            const reply = await interaction.fetchReply();
            return messageId(reply);
        } catch {
            return undefined;
        }
    }

    private pruneSessions() {
        const now = this.now();
        for (const [id, session] of this.sessions) {
            if (session.expiresAt <= now) this.sessions.delete(id);
        }
        while (this.sessions.size > MAX_SESSIONS) {
            const oldest = this.sessions.keys().next().value as string | undefined;
            if (!oldest) return;
            this.sessions.delete(oldest);
        }
    }
}
