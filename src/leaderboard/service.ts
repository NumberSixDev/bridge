/* eslint-disable no-nested-ternary, no-restricted-syntax, class-methods-use-this, no-constant-condition */

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ChatInputCommandInteraction,
    EmbedBuilder,
    InteractionEditReplyOptions,
    AutocompleteInteraction,
} from 'discord.js';
import { randomUUID } from 'crypto';
import winston from 'winston';
import env from '@util/env';
import { formatAmount } from '../recruitment/amount';
import { DragSimLeaderboardClient } from './api';
import { findMetricDefinition, isLeaderboardCategory, metricChoices } from './metrics';
import { GuildRosterCollector, GUILD_ROSTER_REFRESH_MS } from './roster';
import { playerLabel } from './presentation';
import {
    LEADERBOARD_CATEGORIES,
    GuildRoster,
    LeaderboardCategory,
    LeaderboardLookupClient,
    LeaderboardSnapshot,
    MetricDefinition,
    NetworthSnapshot,
    ProfileSnapshot,
    RankedPlayer,
} from './types';

const PROFILE_CACHE_MS = 5 * 60_000;
const NETWORTH_CACHE_MS = 5 * 60_000;
const SESSION_TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 100;
const MAX_PROFILE_CACHE = 500;
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

interface LeaderboardSession {
    id: string;
    guildId: string;
    channelId: string;
    messageId: string;
    expiresAt: number;
    snapshot: LeaderboardSnapshot;
}

export interface LeaderboardServiceOptions {
    sendMinecraftCommand: (command: string) => void;
    isMinecraftReady: () => boolean;
    lookup?: LeaderboardLookupClient;
    now?: () => number;
    cooldownMs?: number;
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

export default class LeaderboardService {
    public readonly roster: GuildRosterCollector;
    private readonly lookup: LeaderboardLookupClient;
    private readonly now: () => number;
    private readonly cooldownMs: number;
    private readonly profileCache = new Map<string, CachedProfile>();
    private readonly profileInflight = new Map<string, Promise<ProfileSnapshot>>();
    private readonly networthCache = new Map<string, CachedNetworth>();
    private readonly networthInflight = new Map<string, Promise<NetworthSnapshot>>();
    private readonly sessions = new Map<string, LeaderboardSession>();
    private readonly lastCommandAt = new Map<string, number>();
    private stopped = false;
    private rosterTimer?: ReturnType<typeof setInterval>;
    private refreshing = false;
    private lastRefreshAt = -Infinity;
    private cacheGeneration = 0;

    public constructor(options: LeaderboardServiceOptions) {
        this.lookup = options.lookup ?? new DragSimLeaderboardClient();
        this.now = options.now ?? Date.now;
        this.cooldownMs = options.cooldownMs ?? COMMAND_COOLDOWN_MS;
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
        clearInterval(this.rosterTimer);
        this.rosterTimer = setInterval(() => {
            this.roster.getRoster(true).catch((error: unknown) => {
                winston.warn(
                    `Scheduled guild roster refresh failed: ${
                        error instanceof Error ? error.message : error
                    }`
                );
            });
        }, GUILD_ROSTER_REFRESH_MS);
        this.rosterTimer.unref();
        await this.roster.getRoster().catch((error: unknown) => {
            winston.warn(
                `Initial guild leaderboard roster refresh failed: ${
                    error instanceof Error ? error.message : error
                }`
            );
        });
    }

    public handleMinecraftMessage(message: string) {
        this.roster.handleMessage(message);
    }

    public onMinecraftDisconnected() {
        clearInterval(this.rosterTimer);
        this.rosterTimer = undefined;
        this.roster.disconnected();
    }

    public stop() {
        this.stopped = true;
        clearInterval(this.rosterTimer);
        this.rosterTimer = undefined;
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
            const result = await this.buildSnapshot(
                'networth',
                undefined,
                roster.members,
                roster.observedAt
            );
            if (typeof result === 'string') {
                await interaction.editReply({ content: result });
                return;
            }
            const profiles = roster.members.filter((name) =>
                this.profileCache.has(name.toLowerCase())
            ).length;
            await interaction.editReply({
                content: `Refreshed the guild list (${roster.members.length} members). Fresh player stats: ${profiles}/${roster.members.length}; networth available: ${result.rows.length}/${roster.members.length}. Run /gleaderboard again to view the refreshed data.`,
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
        await interaction.respond(
            metricChoices(category, cloneProfileList(this.profileCache), query)
        );
    }

    public async handleCommand(interaction: ChatInputCommandInteraction) {
        let category: LeaderboardCategory;
        try {
            const rawCategory = interaction.options.getSubcommand();
            if (!isLeaderboardCategory(rawCategory))
                throw new Error('That leaderboard category is not recognised.');
            category = rawCategory;
        } catch (error) {
            await interaction.reply({
                content:
                    error instanceof Error
                        ? error.message
                        : 'That leaderboard category is not recognised.',
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

        let roster;
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

        const requested =
            category === 'networth' || category === 'purse'
                ? undefined
                : interaction.options.getString('stat', false) ?? undefined;
        const snapshot = await this.buildSnapshot(
            category,
            requested,
            roster.members,
            roster.observedAt
        );
        if (typeof snapshot === 'string') {
            await interaction.editReply({ content: snapshot, components: [] });
            return;
        }
        // A cold guild-wide lookup may outlive the roster cache. Recheck before publishing.
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

        const sessionId = randomUUID();
        const session: LeaderboardSession = {
            id: sessionId,
            guildId: env.DISCORD_SERVER_ID,
            channelId: interaction.channelId,
            messageId: '',
            expiresAt: this.now() + SESSION_TTL_MS,
            snapshot,
        };
        this.sessions.set(sessionId, session);
        this.pruneSessions();
        const reply = await interaction.editReply(this.payload(session, 0));
        const messageId = await this.replyMessageId(interaction, reply);
        if (!messageId) {
            this.sessions.delete(sessionId);
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

        let roster;
        try {
            roster = await this.roster.getRoster();
        } catch (error) {
            await this.privateFollowUp(
                interaction,
                error instanceof Error ? error.message : 'The current guild roster is unavailable.'
            );
            return;
        }
        this.applyRoster(session.snapshot, roster);
        session.expiresAt = this.now() + SESSION_TTL_MS;
        const pageCount = this.pageCount(session.snapshot.rows);
        const currentPage = this.pageFromMessage(interaction);
        const page = match[2] === 'next' ? currentPage + 1 : currentPage - 1;
        const bounded = Math.min(Math.max(page, 0), pageCount - 1);
        await interaction.editReply(this.payload(session, bounded));
    }

    private async buildSnapshot(
        category: LeaderboardCategory,
        requested: string | undefined,
        members: string[],
        rosterObservedAt: number
    ): Promise<LeaderboardSnapshot | string> {
        if (!members.length)
            return 'The current Minecraft guild roster is empty; nothing can be ranked.';
        const deadline = this.now() + 120_000;
        const profileResults = await parallelMap(members, 2, async (username) => {
            try {
                if (this.stopped || this.now() >= deadline)
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
        const metric = findMetricDefinition(category, requested, profiles);
        if (!metric || metric.category !== category) {
            return requested
                ? `That ${category} stat is not available. Choose one of the autocomplete options.`
                : `No usable ${category} stat is available for the current guild.`;
        }

        const networths = new Map<string, NetworthSnapshot>();
        if (category === 'networth') {
            const networthResults = await parallelMap(profiles, 2, async (profile) => {
                try {
                    if (this.stopped || this.now() >= deadline)
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

        const rows: RankedPlayer[] = [];
        let unavailableCount = members.length - profiles.length;
        let partialCount = 0;
        for (const profile of profiles) {
            const networth = networths.get(profile.username.toLowerCase());
            const value = metric.extract(profile, networth);
            if (value === undefined || !Number.isFinite(value) || value < 0) {
                unavailableCount += 1;
                continue;
            }
            const approximate = category === 'networth' && networth?.partial === true;
            if (approximate) partialCount += 1;
            rows.push({ username: profile.username, rank: profile.rank, value, approximate });
        }
        rows.sort((left, right) => {
            if (right.value !== left.value) return right.value - left.value;
            return (
                left.username.toLowerCase().localeCompare(right.username.toLowerCase()) ||
                left.username.localeCompare(right.username)
            );
        });
        const profileDataTimestamps = profiles.map(
            (profile) => profile.profileSavedAt ?? profile.observedAt
        );
        return {
            category,
            metric,
            rows,
            rosterCount: members.length,
            unavailableCount,
            partialCount,
            rosterObservedAt,
            oldestProfileDataAt: profileDataTimestamps.length
                ? Math.min(...profileDataTimestamps)
                : undefined,
            snapshotAt: this.now(),
        };
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

    private pageCount(rows: RankedPlayer[]) {
        return Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    }

    private pageFromMessage(interaction: ButtonInteraction<'cached'>) {
        const footer = interaction.message.embeds[0]?.footer?.text ?? '';
        const match = footer.match(/Page (\d+)\/(\d+)/);
        const page = Number(match?.[1] ?? 1);
        return Number.isSafeInteger(page) && page > 0 ? page - 1 : 0;
    }

    private payload(session: LeaderboardSession, page: number): InteractionEditReplyOptions {
        const { snapshot } = session;
        const pageCount = this.pageCount(snapshot.rows);
        const boundedPage = Math.min(Math.max(page, 0), pageCount - 1);
        const rows = snapshot.rows.slice(boundedPage * PAGE_SIZE, (boundedPage + 1) * PAGE_SIZE);
        const description = [
            `Ranked **${snapshot.rows.length}** of **${snapshot.rosterCount}** current guild members.`,
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
            .setFooter({ text: `Page ${boundedPage + 1}/${pageCount}` });
        const components =
            snapshot.rows.length > 0
                ? [
                      new ActionRowBuilder<ButtonBuilder>().addComponents(
                          new ButtonBuilder()
                              .setCustomId(`gleaderboard:${session.id}:prev`)
                              .setLabel('◀')
                              .setStyle(ButtonStyle.Secondary)
                              .setDisabled(boundedPage === 0),
                          new ButtonBuilder()
                              .setCustomId(`gleaderboard:${session.id}:page`)
                              .setLabel(`Page ${boundedPage + 1}/${pageCount}`)
                              .setStyle(ButtonStyle.Secondary)
                              .setDisabled(true),
                          new ButtonBuilder()
                              .setCustomId(`gleaderboard:${session.id}:next`)
                              .setLabel('▶')
                              .setStyle(ButtonStyle.Secondary)
                              .setDisabled(boundedPage === pageCount - 1)
                      ),
                  ]
                : [];
        return { embeds: [embed], components };
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
}

export { LEADERBOARD_CATEGORIES };
