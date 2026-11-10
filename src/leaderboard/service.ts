/* eslint-disable no-nested-ternary, no-restricted-syntax, class-methods-use-this, no-constant-condition */

import {
    ActionRowBuilder,
    AutocompleteInteraction,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ChatInputCommandInteraction,
    EmbedBuilder,
    InteractionEditReplyOptions,
} from 'discord.js';
import { randomUUID } from 'crypto';
import { promises as fsPromises, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import winston from 'winston';
import env from '@util/env';
import { formatAmount } from '../recruitment/amount';
import { DragSimLeaderboardClient } from './api';
import { isLeaderboardCategory, metricChoices, metricDefinitions } from './metrics';
import { GuildRosterCollector, GUILD_ROSTER_REFRESH_MS, isValidMinecraftUsername } from './roster';
import { compareRankingValues, rankingPosition, sortRankingValues } from './ranking';
import { playerLabel } from './presentation';
import {
    LEADERBOARD_CATEGORIES,
    GuildRoster,
    LeaderboardCategory,
    LeaderboardDataset,
    LeaderboardLookupClient,
    LeaderboardSnapshot,
    MetricDefinition,
    MetricDescriptor,
    NetworthSnapshot,
    PlayerReport,
    PlayerReportEntry,
    PlayerStatsRecord,
    ProfileSnapshot,
    RankedPlayer,
} from './types';

const PROFILE_CACHE_MS = 5 * 60_000;
const NETWORTH_CACHE_MS = 5 * 60_000;
const STATS_FRESH_MS = 5 * 60_000;
const STATS_MAX_STALE_MS = 15 * 60_000;
const STATS_REFRESH_MS = 5 * 60_000;
const SESSION_TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 100;
const MAX_PROFILE_CACHE = 500;
const MAX_DATASET_RECORDS = 500;
const MAX_DATASET_METRICS = 1_000;
const MAX_CACHE_BYTES = 2_000_000;
const COMMAND_COOLDOWN_MS = 5_000;
const PAGE_SIZE = 25;
const BUTTON_PATTERN = /^gleaderboard:([A-Za-z0-9_-]{1,80}):(prev|next)$/;

interface CachedProfile {
    value: ProfileSnapshot;
    cachedAt: number;
}

interface CachedNetworth {
    value: NetworthSnapshot;
    cachedAt: number;
}

interface PlayerReportSession extends PlayerReport {
    dataset: LeaderboardDataset;
}

interface LeaderboardSession {
    id: string;
    guildId: string;
    channelId: string;
    messageId: string;
    expiresAt: number;
    snapshot?: LeaderboardSnapshot;
    report?: PlayerReportSession;
}

export interface LeaderboardServiceOptions {
    sendMinecraftCommand: (command: string) => void;
    isMinecraftReady: () => boolean;
    lookup?: LeaderboardLookupClient;
    now?: () => number;
    cooldownMs?: number;
    dataDir?: string;
}

function cloneProfileList(cache: Map<string, CachedProfile>) {
    return [...cache.values()].map((entry) => entry.value);
}

function ageLabel(ageMs: number) {
    const seconds = Math.max(0, Math.floor(ageMs / 1_000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ago`;
}

function valueLabel(value: number, definition: MetricDefinition, approximate: boolean) {
    const amount = formatAmount(value);
    const suffix =
        definition.unit === 'xp'
            ? ' XP'
            : definition.unit === 'kills'
            ? ' kills'
            : definition.unit === 'count'
            ? ' count'
            : definition.unit === 'level'
            ? ' level'
            : definition.unit === 'score'
            ? ' score'
            : '';
    return `${approximate ? '≈' : ''}${amount}${suffix}`;
}

function descriptorMetric(descriptor: MetricDescriptor): MetricDefinition {
    return {
        ...descriptor,
        extract: () => undefined,
    };
}

async function parallelMap<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>) {
    const results: R[] = [];
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const index = next++;
            if (index >= items.length) return;
            // eslint-disable-next-line no-await-in-loop
            results[index] = await worker(items[index]!);
        }
    });
    await Promise.all(runners);
    return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= Number.MAX_SAFE_INTEGER
    );
}

function stringWithin(value: unknown, maxLength: number) {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

export default class LeaderboardService {
    public readonly roster: GuildRosterCollector;
    private readonly lookup: LeaderboardLookupClient;
    private readonly now: () => number;
    private readonly cooldownMs: number;
    private readonly dataDir?: string;
    private readonly profileCache = new Map<string, CachedProfile>();
    private readonly profileInflight = new Map<string, Promise<ProfileSnapshot>>();
    private readonly networthCache = new Map<string, CachedNetworth>();
    private readonly networthInflight = new Map<string, Promise<NetworthSnapshot>>();
    private readonly sessions = new Map<string, LeaderboardSession>();
    private readonly lastCommandAt = new Map<string, number>();
    private stopped = false;
    private rosterTimer?: ReturnType<typeof setInterval>;
    private statsTimer?: ReturnType<typeof setInterval>;
    private refreshing = false;
    private lastRefreshAt = -Infinity;
    private cacheGeneration = 0;
    private lifecycleGeneration = 0;
    private dataset?: LeaderboardDataset;
    private refreshPromise?: Promise<LeaderboardDataset>;
    private refreshIncludesNetworth = false;

    public constructor(options: LeaderboardServiceOptions) {
        this.lookup = options.lookup ?? new DragSimLeaderboardClient();
        this.now = options.now ?? Date.now;
        this.cooldownMs = options.cooldownMs ?? COMMAND_COOLDOWN_MS;
        this.dataDir = options.dataDir;
        this.dataset = this.loadDataset();
        this.roster = new GuildRosterCollector({
            sendCommand: options.sendMinecraftCommand,
            isMinecraftReady: options.isMinecraftReady,
            now: this.now,
        });
    }

    public ownsInteraction(interaction: { customId?: string }) {
        return (
            typeof interaction.customId === 'string' &&
            interaction.customId.startsWith('gleaderboard:')
        );
    }

    public async onMinecraftReady() {
        if (this.stopped) return;
        this.lifecycleGeneration += 1;
        const lifecycle = this.lifecycleGeneration;
        clearInterval(this.rosterTimer);
        clearInterval(this.statsTimer);
        this.rosterTimer = setInterval(() => {
            this.roster
                .getRoster(true)
                .then((roster) => this.startDatasetRefresh(roster, true))
                .catch((error: unknown) => {
                    winston.warn(
                        `Scheduled guild leaderboard refresh failed: ${
                            error instanceof Error ? error.message : error
                        }`
                    );
                });
        }, GUILD_ROSTER_REFRESH_MS);
        this.rosterTimer.unref();
        this.statsTimer = setInterval(() => {
            this.refreshInBackground().catch((error: unknown) => {
                winston.warn(
                    `Scheduled player stats refresh failed: ${
                        error instanceof Error ? error.message : error
                    }`
                );
            });
        }, STATS_REFRESH_MS);
        this.statsTimer.unref();
        const roster = await this.roster.getRoster().catch((error: unknown) => {
            winston.warn(
                `Initial guild leaderboard roster refresh failed: ${
                    error instanceof Error ? error.message : error
                }`
            );
            return undefined;
        });
        if (roster && !this.stopped && lifecycle === this.lifecycleGeneration)
            this.startDatasetRefresh(roster, true).catch((error: unknown) => {
                winston.warn(
                    `Initial player stats refresh failed: ${
                        error instanceof Error ? error.message : error
                    }`
                );
            });
    }

    public handleMinecraftMessage(message: string) {
        this.roster.handleMessage(message);
    }

    public onMinecraftDisconnected() {
        this.lifecycleGeneration += 1;
        clearInterval(this.rosterTimer);
        clearInterval(this.statsTimer);
        this.rosterTimer = undefined;
        this.statsTimer = undefined;
        this.roster.disconnected();
    }

    public stop() {
        this.stopped = true;
        this.lifecycleGeneration += 1;
        clearInterval(this.rosterTimer);
        clearInterval(this.statsTimer);
        this.rosterTimer = undefined;
        this.statsTimer = undefined;
        this.roster.stop();
        this.sessions.clear();
        this.profileCache.clear();
        this.networthCache.clear();
        this.profileInflight.clear();
        this.networthInflight.clear();
    }

    public getRoster() {
        return this.roster.getRoster();
    }

    public async handleRefresh(interaction: ChatInputCommandInteraction) {
        if (this.refreshing || this.now() - this.lastRefreshAt < 60_000) {
            await interaction.reply({
                content: this.refreshing
                    ? 'A refresh is already running. Please wait for it to finish.'
                    : 'The data was refreshed recently. Please wait a minute before refreshing again.',
                ephemeral: true,
            });
            return;
        }
        this.refreshing = true;
        this.lastRefreshAt = this.now();
        try {
            await interaction.deferReply({ ephemeral: true });
            const roster = await this.roster.getRoster(true);
            this.cacheGeneration += 1;
            this.profileCache.clear();
            this.networthCache.clear();
            this.profileInflight.clear();
            this.networthInflight.clear();
            const dataset = await this.startDatasetRefresh(roster, true);
            const snapshot = this.snapshotFromDataset(
                'networth',
                undefined,
                roster.members,
                dataset
            );
            if (typeof snapshot === 'string') {
                await interaction.editReply({ content: snapshot });
                return;
            }
            const currentRecords = new Set(roster.members.map((name) => name.toLowerCase()));
            const profiles = dataset.records.filter((record) =>
                currentRecords.has(record.username.toLowerCase())
            ).length;
            await interaction.editReply({
                content: `Refreshed the guild list (${roster.members.length} members). Fresh player stats: ${profiles}/${roster.members.length}; networth available: ${snapshot.rows.length}/${roster.members.length}. Run /gleaderboard again to view the refreshed data.`,
            });
        } catch (error) {
            await interaction.editReply({
                content: `Refresh could not complete: ${
                    error instanceof Error ? error.message : 'Please try again shortly.'
                }`,
            });
        } finally {
            this.refreshing = false;
        }
    }

    public async handleAutocomplete(interaction: AutocompleteInteraction<'cached'>) {
        if (interaction.commandName !== 'gleaderboard') {
            await interaction.respond([]);
            return;
        }
        let category: string;
        try {
            category = interaction.options.getSubcommand();
        } catch {
            await interaction.respond([]);
            return;
        }
        if (!isLeaderboardCategory(category) || category === 'networth' || category === 'purse') {
            await interaction.respond([]);
            return;
        }
        const query = interaction.options.getString('stat', false) ?? '';
        const dataset = this.usableDataset(false);
        if (dataset) {
            const normalized = query.trim().toLowerCase();
            await interaction.respond(
                dataset.metrics
                    .filter(
                        (metric) =>
                            metric.category === category &&
                            (metric.id.toLowerCase().includes(normalized) ||
                                metric.label.toLowerCase().includes(normalized))
                    )
                    .slice(0, 25)
                    .map((metric) => ({ name: metric.label.slice(0, 100), value: metric.id }))
            );
        } else {
            await interaction.respond(
                metricChoices(category, cloneProfileList(this.profileCache), query)
            );
        }
    }

    public async handleCommand(interaction: ChatInputCommandInteraction) {
        const searchStartedAt = performance.now();
        let rawCategory: string;
        try {
            rawCategory = interaction.options.getSubcommand();
        } catch {
            await interaction.reply({
                content: 'That leaderboard category is not recognised.',
                ephemeral: true,
            });
            return;
        }
        const isPlayerReport = rawCategory === 'player';
        if (!isPlayerReport && !isLeaderboardCategory(rawCategory)) {
            await interaction.reply({
                content: 'That leaderboard category is not recognised.',
                ephemeral: true,
            });
            return;
        }

        this.pruneSessions();
        const now = this.now();
        const previous = this.lastCommandAt.get(interaction.user.id);
        if (previous !== undefined && now - previous < this.cooldownMs) {
            await interaction.reply({
                content: 'Please wait a few seconds before requesting another leaderboard.',
                ephemeral: true,
            });
            return;
        }
        this.lastCommandAt.set(interaction.user.id, now);
        await interaction.deferReply();

        let roster: GuildRoster;
        try {
            roster = await this.roster.getRoster();
        } catch (error) {
            await interaction.editReply({
                content:
                    error instanceof Error
                        ? error.message
                        : 'The current guild roster is unavailable.',
                components: [],
            });
            return;
        }

        if (isPlayerReport) {
            await this.handlePlayerCommand(interaction, roster, searchStartedAt);
            return;
        }

        const category = rawCategory as LeaderboardCategory;
        const requested =
            category === 'networth' || category === 'purse'
                ? undefined
                : interaction.options.getString('stat', false) ?? undefined;
        const dataset = await this.ensureDataset(roster, category === 'networth');
        if (typeof dataset === 'string') {
            await interaction.editReply({ content: dataset, components: [] });
            return;
        }
        const snapshot = this.snapshotFromDataset(category, requested, roster.members, dataset);
        if (typeof snapshot === 'string') {
            await interaction.editReply({ content: snapshot, components: [] });
            return;
        }

        try {
            this.applyRoster(snapshot, await this.roster.getRoster());
        } catch {
            await interaction.editReply({
                content:
                    'The current guild roster could not be verified. Please try again shortly.',
                components: [],
            });
            return;
        }

        snapshot.searchDurationMs = Math.max(0, performance.now() - searchStartedAt);
        const session = this.newSession(interaction, snapshot);
        const reply = await interaction.editReply(this.payload(session, 0));
        const messageId = await this.replyMessageId(interaction, reply);
        if (!messageId) {
            this.sessions.delete(session.id);
            return;
        }
        session.messageId = messageId;
    }

    private async handlePlayerCommand(
        interaction: ChatInputCommandInteraction,
        roster: GuildRoster,
        searchStartedAt: number
    ) {
        const username = interaction.options.getString('username', true).trim();
        if (!isValidMinecraftUsername(username)) {
            await interaction.editReply({
                content: 'That Minecraft username is invalid.',
                components: [],
            });
            return;
        }
        const member = roster.members.find((name) => name.toLowerCase() === username.toLowerCase());
        if (!member) {
            await interaction.editReply({
                content: `**${username}** is not a current member of the Minecraft guild.`,
                components: [],
            });
            return;
        }

        const dataset = await this.ensureDataset(roster, true);
        if (typeof dataset === 'string') {
            await interaction.editReply({ content: dataset, components: [] });
            return;
        }
        let currentRoster: GuildRoster;
        try {
            currentRoster = await this.roster.getRoster();
        } catch {
            await interaction.editReply({
                content:
                    'The current guild roster could not be verified. Please try again shortly.',
                components: [],
            });
            return;
        }
        const currentMember = currentRoster.members.find(
            (name) => name.toLowerCase() === member.toLowerCase()
        );
        if (!currentMember) {
            await interaction.editReply({
                content: `**${member}** is no longer a current member of the Minecraft guild.`,
                components: [],
            });
            return;
        }

        const report = this.buildPlayerReport(
            dataset,
            currentRoster,
            currentMember,
            Math.max(0, performance.now() - searchStartedAt)
        );
        const session = this.newSession(interaction, undefined, report);
        const reply = await interaction.editReply(this.payload(session, 0));
        const messageId = await this.replyMessageId(interaction, reply);
        if (!messageId) {
            this.sessions.delete(session.id);
            return;
        }
        session.messageId = messageId;
    }

    public async handleInteraction(interaction: ButtonInteraction<'cached'>) {
        const match = interaction.customId.match(BUTTON_PATTERN);
        await interaction.deferUpdate();
        if (!match?.[1] || !match[2]) {
            await this.privateFollowUp(interaction, 'That leaderboard control is not recognised.');
            return;
        }
        const session = this.sessions.get(match[1]);
        if (
            !session ||
            session.expiresAt <= this.now() ||
            this.now() -
                (session.report?.datasetCompletedAt ?? session.snapshot?.statsUpdatedAt ?? 0) >
                STATS_MAX_STALE_MS ||
            interaction.guildId !== session.guildId ||
            interaction.guildId !== env.DISCORD_SERVER_ID ||
            interaction.channelId !== session.channelId ||
            interaction.message.id !== session.messageId ||
            interaction.message.guildId !== session.guildId
        ) {
            await this.privateFollowUp(
                interaction,
                'That leaderboard has expired or is no longer active. Run /gleaderboard again.'
            );
            return;
        }

        let roster: GuildRoster;
        try {
            roster = await this.roster.getRoster();
        } catch (error) {
            await this.privateFollowUp(
                interaction,
                error instanceof Error ? error.message : 'The current guild roster is unavailable.'
            );
            return;
        }
        const currentPage = this.pageFromMessage(interaction);
        if (session.report) {
            const currentMember = roster.members.find(
                (name) => name.toLowerCase() === session.report!.username.toLowerCase()
            );
            if (!currentMember) {
                this.sessions.delete(session.id);
                await interaction.editReply({
                    content:
                        'That player is no longer a current guild member. Run /gleaderboard again.',
                    embeds: [],
                    components: [],
                });
                return;
            }
            const refreshedReport = this.buildPlayerReport(
                session.report.dataset,
                roster,
                currentMember,
                session.report.searchDurationMs ?? 0
            );
            session.report = refreshedReport;
            session.expiresAt = this.now() + SESSION_TTL_MS;
            const pageCount = this.pageCount(refreshedReport.entries);
            const page = match[2] === 'next' ? currentPage + 1 : currentPage - 1;
            const bounded = Math.min(Math.max(page, 0), pageCount - 1);
            await interaction.editReply(this.payload(session, bounded));
            return;
        }

        if (!session.snapshot) {
            await this.privateFollowUp(interaction, 'That leaderboard session is invalid.');
            return;
        }
        this.applyRoster(session.snapshot, roster);
        session.snapshot.statsRefreshOngoing = Boolean(this.refreshPromise);
        session.expiresAt = this.now() + SESSION_TTL_MS;
        const pageCount = this.pageCount(session.snapshot.rows);
        const page = match[2] === 'next' ? currentPage + 1 : currentPage - 1;
        const bounded = Math.min(Math.max(page, 0), pageCount - 1);
        await interaction.editReply(this.payload(session, bounded));
    }

    private newSession(
        interaction: ChatInputCommandInteraction,
        snapshot?: LeaderboardSnapshot,
        report?: PlayerReportSession
    ) {
        const session: LeaderboardSession = {
            id: randomUUID(),
            guildId: env.DISCORD_SERVER_ID,
            channelId: interaction.channelId,
            messageId: '',
            expiresAt: this.now() + SESSION_TTL_MS,
            snapshot,
            report,
        };
        this.sessions.set(session.id, session);
        this.pruneSessions();
        return session;
    }

    private async ensureDataset(
        roster: GuildRoster,
        requireNetworth: boolean
    ): Promise<LeaderboardDataset | string> {
        const usable = this.usableDataset(requireNetworth);
        if (usable) {
            if (this.now() - usable.completedAt > STATS_FRESH_MS)
                this.startDatasetRefresh(roster, true).catch((error: unknown) => {
                    winston.warn(
                        `Background player stats refresh failed: ${
                            error instanceof Error ? error.message : error
                        }`
                    );
                });
            return usable;
        }
        try {
            return await this.startDatasetRefresh(roster, requireNetworth);
        } catch (error) {
            const fallback = this.usableDataset(requireNetworth);
            if (fallback) return fallback;
            return `Player stats are not available yet: ${
                error instanceof Error ? error.message : 'please try again shortly.'
            }`;
        }
    }

    private usableDataset(requireNetworth: boolean) {
        if (!this.dataset) return undefined;
        const age = this.now() - this.dataset.completedAt;
        if (age < -60_000 || age > STATS_MAX_STALE_MS) return undefined;
        if (requireNetworth && !this.dataset.includesNetworth) return undefined;
        return this.dataset;
    }

    private startDatasetRefresh(
        roster: GuildRoster,
        includeNetworth: boolean
    ): Promise<LeaderboardDataset> {
        if (this.stopped) return Promise.reject(new Error('Leaderboard service is stopped.'));
        if (this.refreshPromise) {
            if (this.refreshIncludesNetworth || !includeNetworth) return this.refreshPromise;
            return this.refreshPromise.then(() => this.startDatasetRefresh(roster, true));
        }
        const lifecycle = this.lifecycleGeneration;
        this.refreshIncludesNetworth = includeNetworth;
        const request = this.collectDataset(roster, includeNetworth, lifecycle)
            .then((dataset) => {
                if (this.stopped || lifecycle !== this.lifecycleGeneration)
                    throw new Error('Minecraft connection changed during the stats refresh.');
                this.dataset = dataset;
                return this.persistDataset(dataset).then(() => dataset);
            })
            .finally(() => {
                if (this.refreshPromise === request) {
                    this.refreshPromise = undefined;
                    this.refreshIncludesNetworth = false;
                }
            });
        this.refreshPromise = request;
        return request;
    }

    private async refreshInBackground() {
        if (this.stopped) return;
        const roster = await this.roster.getRoster();
        await this.startDatasetRefresh(roster, true);
    }

    private async collectDataset(
        roster: GuildRoster,
        includeNetworth: boolean,
        lifecycle: number
    ): Promise<LeaderboardDataset> {
        if (!roster.members.length)
            throw new Error('The current Minecraft guild roster is empty; nothing can be ranked.');
        const deadline = this.now() + 120_000;
        const profileResults = await parallelMap(roster.members, 2, async (username) => {
            try {
                if (
                    this.stopped ||
                    lifecycle !== this.lifecycleGeneration ||
                    this.now() >= deadline
                )
                    throw new Error('Lookup deadline reached.');
                return { username, profile: await this.getProfile(username) };
            } catch (error) {
                return { username, error };
            }
        });
        const profiles: ProfileSnapshot[] = profileResults.flatMap((result) => {
            if ('profile' in result && result.profile) return [result.profile];
            return [];
        });
        if (!profiles.length)
            throw new Error('No usable player profiles were returned for the current guild.');

        const definitionsById = new Map<string, MetricDefinition>();
        for (const category of LEADERBOARD_CATEGORIES) {
            for (const definition of metricDefinitions(category, profiles)) {
                if (!definitionsById.has(definition.id))
                    definitionsById.set(definition.id, definition);
            }
        }
        const definitions = [...definitionsById.values()].slice(0, MAX_DATASET_METRICS);
        const networths = new Map<string, NetworthSnapshot>();
        if (includeNetworth) {
            const networthResults = await parallelMap(profiles, 2, async (profile) => {
                try {
                    if (
                        this.stopped ||
                        lifecycle !== this.lifecycleGeneration ||
                        this.now() >= deadline
                    )
                        throw new Error('Lookup deadline reached.');
                    return {
                        profile,
                        networth: await this.getNetworth(profile.username, profile.profileId),
                    };
                } catch (error) {
                    return { profile, error };
                }
            });
            for (const result of networthResults) {
                if ('networth' in result && result.networth)
                    networths.set(result.profile.username.toLowerCase(), result.networth);
            }
        }

        const records: PlayerStatsRecord[] = profiles
            .slice(0, MAX_DATASET_RECORDS)
            .map((profile) => {
                const networth = networths.get(profile.username.toLowerCase());
                const values: Record<string, number> = {};
                const approximate: Record<string, boolean> = {};
                for (const definition of definitions) {
                    const value = definition.extract(profile, networth);
                    if (value === undefined || !finiteNumber(value)) continue;
                    values[definition.id] = value;
                    if (definition.category === 'networth' && networth?.partial === true)
                        approximate[definition.id] = true;
                }
                return {
                    username: profile.username,
                    rank: profile.rank,
                    uuid: profile.uuid,
                    profileId: profile.profileId,
                    profileObservedAt: profile.profileSavedAt ?? profile.observedAt,
                    values,
                    approximate,
                };
            });

        return {
            schemaVersion: 1,
            context: {
                serverId: env.DISCORD_SERVER_ID,
                apiBaseUrl: new URL(env.RECRUITMENT_API_BASE_URL).toString(),
                mode: 'main',
            },
            completedAt: this.now(),
            rosterObservedAt: roster.observedAt,
            includesNetworth: includeNetworth,
            metrics: definitions.map(({ extract: _extract, ...descriptor }) => descriptor),
            records,
        };
    }

    private snapshotFromDataset(
        category: LeaderboardCategory,
        requested: string | undefined,
        members: string[],
        dataset: LeaderboardDataset
    ): LeaderboardSnapshot | string {
        if (!members.length)
            return 'The current Minecraft guild roster is empty; nothing can be ranked.';
        const descriptor =
            dataset.metrics.find(
                (metric) =>
                    metric.category === category &&
                    (requested ? metric.id === requested : metric.default === true)
            ) ??
            (requested
                ? undefined
                : dataset.metrics.find((metric) => metric.category === category));
        if (!descriptor) {
            return requested
                ? `That ${category} stat is not available. Choose one of the autocomplete options.`
                : `No usable ${category} stat is available for the current guild.`;
        }
        const records = new Map(
            dataset.records.map((record) => [record.username.toLowerCase(), record])
        );
        const rows: RankedPlayer[] = [];
        for (const username of members) {
            const record = records.get(username.toLowerCase());
            if (!record) continue;
            const value = record?.values[descriptor.id];
            if (value === undefined || !finiteNumber(value)) continue;
            rows.push({
                username: record.username,
                rank: record.rank,
                value,
                approximate: record.approximate[descriptor.id] === true,
            });
        }
        const sorted = sortRankingValues(rows);
        const profileDataTimestamps = members.flatMap((username) => {
            const timestamp = records.get(username.toLowerCase())?.profileObservedAt;
            return timestamp === undefined ? [] : [timestamp];
        });
        return {
            category,
            metric: descriptorMetric(descriptor),
            rows: sorted,
            rosterCount: members.length,
            unavailableCount: members.length - sorted.length,
            partialCount: sorted.filter((row) => row.approximate === true).length,
            rosterObservedAt: dataset.rosterObservedAt,
            oldestProfileDataAt: profileDataTimestamps.length
                ? Math.min(...profileDataTimestamps)
                : undefined,
            snapshotAt: this.now(),
            statsUpdatedAt: dataset.completedAt,
            statsRefreshOngoing: Boolean(this.refreshPromise),
        };
    }

    private buildPlayerReport(
        dataset: LeaderboardDataset,
        roster: GuildRoster,
        username: string,
        searchDurationMs: number
    ): PlayerReportSession {
        const records = new Map(
            dataset.records.map((record) => [record.username.toLowerCase(), record])
        );
        const subject = records.get(username.toLowerCase());
        const defaultMetrics = dataset.metrics.filter((metric) => metric.default === true);
        const individualMetrics = dataset.metrics.filter((metric) => metric.default !== true);
        const metrics = [...defaultMetrics, ...individualMetrics];
        const entries: PlayerReportEntry[] = metrics.map((metric) => {
            const value = subject?.values[metric.id];
            if (value === undefined || !finiteNumber(value)) return { metric };
            const candidates = roster.members.flatMap((member) => {
                const record = records.get(member.toLowerCase());
                const memberValue = record?.values[metric.id];
                return memberValue === undefined || !finiteNumber(memberValue)
                    ? []
                    : record
                    ? [{ username: record.username, value: memberValue }]
                    : [];
            });
            const position = rankingPosition(username, candidates);
            return {
                metric,
                value,
                approximate: subject?.approximate[metric.id] === true,
                position: position?.position,
                rankedMembers: position?.rankedMembers,
            };
        });
        entries.sort(
            (left, right) =>
                (left.position ?? Number.MAX_SAFE_INTEGER) -
                (right.position ?? Number.MAX_SAFE_INTEGER)
        );
        return {
            dataset,
            username,
            rank: subject?.rank,
            profileId: subject?.profileId ?? '',
            rosterCount: roster.members.length,
            rosterObservedAt: roster.observedAt,
            datasetCompletedAt: dataset.completedAt,
            entries,
            searchDurationMs,
            statsRefreshOngoing: Boolean(this.refreshPromise),
        };
    }

    private async buildSnapshot(
        category: LeaderboardCategory,
        requested: string | undefined,
        members: string[],
        rosterObservedAt: number
    ): Promise<LeaderboardSnapshot | string> {
        const dataset = await this.ensureDataset(
            { members, observedAt: rosterObservedAt },
            category === 'networth'
        );
        return typeof dataset === 'string'
            ? dataset
            : this.snapshotFromDataset(category, requested, members, dataset);
    }

    private async getProfile(username: string) {
        const key = username.toLowerCase();
        const cached = this.profileCache.get(key);
        if (cached && this.now() - cached.cachedAt <= PROFILE_CACHE_MS) return cached.value;
        const inFlight = this.profileInflight.get(key);
        if (inFlight) return inFlight;
        const generation = this.cacheGeneration;
        const request = this.lookup.getProfile(username).then((profile) => {
            if (generation === this.cacheGeneration)
                this.profileCache.set(key, { value: profile, cachedAt: this.now() });
            this.pruneProfileCache();
            return profile;
        });
        this.profileInflight.set(key, request);
        request
            .finally(() => {
                if (this.profileInflight.get(key) === request) this.profileInflight.delete(key);
            })
            .catch(() => undefined);
        return request;
    }

    private applyRoster(snapshot: LeaderboardSnapshot, roster: GuildRoster) {
        const currentMembers = new Set(roster.members.map((member) => member.toLowerCase()));
        snapshot.rows = snapshot.rows.filter((row) =>
            currentMembers.has(row.username.toLowerCase())
        );
        snapshot.rows.sort(compareRankingValues);
        snapshot.rosterCount = roster.members.length;
        snapshot.unavailableCount = roster.members.length - snapshot.rows.length;
        snapshot.partialCount = snapshot.rows.filter((row) => row.approximate).length;
        snapshot.rosterObservedAt = roster.observedAt;
    }

    private async getNetworth(username: string, profileId: string) {
        const key = `${username.toLowerCase()}:${profileId}`;
        const cached = this.networthCache.get(key);
        if (cached && this.now() - cached.cachedAt <= NETWORTH_CACHE_MS) return cached.value;
        const inFlight = this.networthInflight.get(key);
        if (inFlight) return inFlight;
        const generation = this.cacheGeneration;
        const request = this.lookup.getNetworth(username, profileId).then((networth) => {
            if (generation === this.cacheGeneration)
                this.networthCache.set(key, { value: networth, cachedAt: this.now() });
            this.pruneNetworthCache();
            return networth;
        });
        this.networthInflight.set(key, request);
        request
            .finally(() => {
                if (this.networthInflight.get(key) === request) this.networthInflight.delete(key);
            })
            .catch(() => undefined);
        return request;
    }

    private pruneProfileCache() {
        while (this.profileCache.size > MAX_PROFILE_CACHE) {
            const oldest = this.profileCache.keys().next().value as string | undefined;
            if (!oldest) return;
            this.profileCache.delete(oldest);
        }
    }

    private pruneNetworthCache() {
        while (this.networthCache.size > MAX_PROFILE_CACHE) {
            const oldest = this.networthCache.keys().next().value as string | undefined;
            if (!oldest) return;
            this.networthCache.delete(oldest);
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

    private pageCount(rows: Array<unknown>) {
        return Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    }

    private pageFromMessage(interaction: ButtonInteraction<'cached'>) {
        const footer = interaction.message.embeds[0]?.footer?.text ?? '';
        const match = footer.match(/(?:Page|Report page) (\d+)\/(\d+)/i);
        const page = Number(match?.[1] ?? 1);
        return Number.isSafeInteger(page) && page > 0 ? page - 1 : 0;
    }

    private navigation(sessionId: string, page: number, pageCount: number) {
        return [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`gleaderboard:${sessionId}:prev`)
                    .setLabel('◀')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId(`gleaderboard:${sessionId}:page`)
                    .setLabel(`Page ${page + 1}/${pageCount}`)
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId(`gleaderboard:${sessionId}:next`)
                    .setLabel('▶')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page === pageCount - 1)
            ),
        ];
    }

    private payload(session: LeaderboardSession, page: number): InteractionEditReplyOptions {
        if (session.report) return this.reportPayload(session, page);
        if (!session.snapshot)
            return { content: 'That leaderboard session is invalid.', components: [] };
        const { snapshot } = session;
        const pageCount = this.pageCount(snapshot.rows);
        const boundedPage = Math.min(Math.max(page, 0), pageCount - 1);
        const rows = snapshot.rows.slice(boundedPage * PAGE_SIZE, (boundedPage + 1) * PAGE_SIZE);
        const description = [
            `Ranked **${snapshot.rows.length}** of **${snapshot.rosterCount}** current guild members.`,
            snapshot.statsUpdatedAt !== undefined
                ? `Stats updated: **${ageLabel(this.now() - snapshot.statsUpdatedAt)}**${
                      snapshot.statsRefreshOngoing ? ' (background refresh ongoing)' : ''
                  }.`
                : undefined,
            `Guild roster snapshot: **${ageLabel(this.now() - snapshot.rosterObservedAt)}**.`,
            snapshot.oldestProfileDataAt !== undefined
                ? `Oldest player profile data: **${ageLabel(
                      this.now() - snapshot.oldestProfileDataAt
                  )}**.`
                : undefined,
            snapshot.unavailableCount
                ? `Unavailable or missing data: **${snapshot.unavailableCount}**.`
                : undefined,
            '',
            rows.length
                ? rows
                      .map(
                          (row, index) =>
                              `**${boundedPage * PAGE_SIZE + index + 1}.** ${playerLabel(
                                  row.username,
                                  row.rank
                              )} — ${valueLabel(
                                  row.value,
                                  snapshot.metric,
                                  row.approximate === true
                              )}`
                      )
                      .join('\n')
                : 'No current guild members have usable data for this leaderboard.',
        ]
            .filter((line): line is string => line !== undefined)
            .join('\n');
        const embed = new EmbedBuilder()
            .setColor('Purple')
            .setTitle(`Guild leaderboard · ${snapshot.metric.label}`)
            .setDescription(description)
            .setFooter({
                text: `Page ${boundedPage + 1}/${pageCount} • Time Taken to Search: ${(
                    (snapshot.searchDurationMs ?? 0) / 1_000
                ).toFixed(2)}s`,
            });
        return {
            embeds: [embed],
            components: snapshot.rows.length
                ? this.navigation(session.id, boundedPage, pageCount)
                : [],
        };
    }

    private reportPayload(session: LeaderboardSession, page: number): InteractionEditReplyOptions {
        const report = session.report!;
        const pageCount = this.pageCount(report.entries);
        const boundedPage = Math.min(Math.max(page, 0), pageCount - 1);
        const entries = report.entries.slice(
            boundedPage * PAGE_SIZE,
            (boundedPage + 1) * PAGE_SIZE
        );
        const description = [
            `Player: **${playerLabel(report.username, report.rank)}**.`,
            `Current guild members: **${report.rosterCount}**.`,
            `Stats updated: **${ageLabel(this.now() - report.datasetCompletedAt)}**${
                report.statsRefreshOngoing ? ' (background refresh ongoing)' : ''
            }.`,
            '',
            entries
                .map((entry) => {
                    const definition = descriptorMetric(entry.metric);
                    const category =
                        entry.metric.category === 'rng'
                            ? 'RNG'
                            : entry.metric.category.charAt(0).toUpperCase() +
                              entry.metric.category.slice(1);
                    const value =
                        entry.value === undefined
                            ? 'Unavailable'
                            : valueLabel(entry.value, definition, entry.approximate === true);
                    const position =
                        entry.position === undefined || entry.rankedMembers === undefined
                            ? 'Unranked'
                            : `#${entry.position} / ${entry.rankedMembers}`;
                    return `**${position}** · ${category} · ${entry.metric.label.slice(
                        0,
                        64
                    )} — ${value}`;
                })
                .join('\n'),
        ].join('\n');
        const embed = new EmbedBuilder()
            .setColor('Purple')
            .setTitle('Guild leaderboard · player report')
            .setDescription(description)
            .setFooter({
                text: `Report page ${boundedPage + 1}/${pageCount} • Time Taken to Search: ${(
                    (report.searchDurationMs ?? 0) / 1_000
                ).toFixed(2)}s`,
            });
        return {
            embeds: [embed],
            components: report.entries.length
                ? this.navigation(session.id, boundedPage, pageCount)
                : [],
        };
    }

    private async replyMessageId(interaction: ChatInputCommandInteraction, reply: unknown) {
        if (reply && typeof reply === 'object' && 'id' in reply && typeof reply.id === 'string') {
            return reply.id;
        }
        try {
            const fetched = await interaction.fetchReply();
            return fetched && typeof fetched.id === 'string' ? fetched.id : undefined;
        } catch {
            return undefined;
        }
    }

    private async privateFollowUp(interaction: ButtonInteraction<'cached'>, content: string) {
        await interaction.followUp({ content, ephemeral: true });
    }

    private cacheFile() {
        return this.dataDir ? path.join(this.dataDir, 'leaderboard-cache.json') : undefined;
    }

    private loadDataset() {
        const file = this.cacheFile();
        if (!file) return undefined;
        try {
            if (statSync(file).size > MAX_CACHE_BYTES) throw new Error('cache is too large');
            const raw = readFileSync(file, 'utf8');
            if (Buffer.byteLength(raw, 'utf8') > MAX_CACHE_BYTES)
                throw new Error('cache is too large');
            const parsed: unknown = JSON.parse(raw);
            const dataset = this.validateDataset(parsed);
            if (
                !dataset ||
                dataset.completedAt > this.now() + 60_000 ||
                this.now() - dataset.completedAt > STATS_MAX_STALE_MS
            )
                return undefined;
            return dataset;
        } catch (error) {
            if (
                error !== null &&
                typeof error === 'object' &&
                'code' in error &&
                error.code === 'ENOENT'
            )
                return undefined;
            winston.warn(
                `Leaderboard cache could not be loaded: ${
                    error instanceof Error ? error.message : 'invalid cache'
                }`
            );
            return undefined;
        }
    }

    private validateDataset(value: unknown): LeaderboardDataset | undefined {
        if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
        const { context } = value;
        if (
            !isRecord(context) ||
            context.serverId !== env.DISCORD_SERVER_ID ||
            context.mode !== 'main' ||
            context.apiBaseUrl !== new URL(env.RECRUITMENT_API_BASE_URL).toString()
        )
            return undefined;
        if (
            !finiteNumber(value.completedAt) ||
            !finiteNumber(value.rosterObservedAt) ||
            typeof value.includesNetworth !== 'boolean' ||
            !Array.isArray(value.metrics) ||
            value.metrics.length > MAX_DATASET_METRICS ||
            !Array.isArray(value.records) ||
            value.records.length > MAX_DATASET_RECORDS
        )
            return undefined;
        const metrics: MetricDescriptor[] = [];
        const metricIds = new Set<string>();
        for (const entry of value.metrics) {
            if (!isRecord(entry)) return undefined;
            const { category } = entry;
            const { unit } = entry;
            const { id } = entry;
            const { label } = entry;
            if (
                !stringWithin(id, 128) ||
                !isLeaderboardCategory(category as string) ||
                !['amount', 'xp', 'kills', 'count', 'level', 'score', 'stat'].includes(
                    unit as string
                ) ||
                typeof label !== 'string' ||
                label.length > 128 ||
                (entry.default !== undefined && typeof entry.default !== 'boolean') ||
                metricIds.has(id as string)
            )
                return undefined;
            metricIds.add(id as string);
            metrics.push({
                id: id as string,
                category: category as LeaderboardCategory,
                label: label as string,
                unit: unit as MetricDescriptor['unit'],
                default: entry.default as boolean | undefined,
            });
        }
        const records: PlayerStatsRecord[] = [];
        const usernames = new Set<string>();
        for (const entry of value.records) {
            if (!isRecord(entry)) return undefined;
            const { username } = entry;
            const { uuid } = entry;
            const { profileId } = entry;
            const { profileObservedAt } = entry;
            if (
                !stringWithin(username, 16) ||
                !isValidMinecraftUsername(username as string) ||
                !stringWithin(uuid, 100) ||
                !stringWithin(profileId, 100) ||
                !finiteNumber(profileObservedAt) ||
                !isRecord(entry.values) ||
                !isRecord(entry.approximate) ||
                usernames.has((username as string).toLowerCase())
            )
                return undefined;
            const values: Record<string, number> = {};
            for (const [id, number] of Object.entries(entry.values)) {
                if (!metricIds.has(id) || !finiteNumber(number)) return undefined;
                values[id] = number;
            }
            const approximate: Record<string, boolean> = {};
            for (const [id, flag] of Object.entries(entry.approximate)) {
                if (!metricIds.has(id) || typeof flag !== 'boolean') return undefined;
                approximate[id] = flag;
            }
            usernames.add((username as string).toLowerCase());
            records.push({
                username: username as string,
                rank: typeof entry.rank === 'string' ? entry.rank.slice(0, 32) : undefined,
                uuid: uuid as string,
                profileId: profileId as string,
                profileObservedAt: profileObservedAt as number,
                values,
                approximate,
            });
        }
        return {
            schemaVersion: 1,
            context: {
                serverId: context.serverId,
                apiBaseUrl: context.apiBaseUrl,
                mode: 'main',
            },
            completedAt: value.completedAt as number,
            rosterObservedAt: value.rosterObservedAt as number,
            includesNetworth: value.includesNetworth,
            metrics,
            records,
        };
    }

    private async persistDataset(dataset: LeaderboardDataset) {
        const file = this.cacheFile();
        if (!file) return;
        const text = JSON.stringify(dataset);
        if (Buffer.byteLength(text, 'utf8') > MAX_CACHE_BYTES) {
            winston.warn('Leaderboard cache was too large to persist.');
            return;
        }
        const directory = path.dirname(file);
        const temporary = path.join(
            directory,
            `.leaderboard-cache-${process.pid}-${randomUUID()}.tmp`
        );
        try {
            await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
            await fsPromises.chmod(directory, 0o700);
            await fsPromises.writeFile(temporary, text, { mode: 0o600 });
            await fsPromises.chmod(temporary, 0o600);
            await fsPromises.rename(temporary, file);
        } catch (error) {
            winston.warn(
                `Leaderboard cache could not be persisted: ${
                    error instanceof Error ? error.message : error
                }`
            );
            await fsPromises.unlink(temporary).catch(() => undefined);
        }
    }
}

export { LEADERBOARD_CATEGORIES };
