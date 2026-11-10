/* eslint-disable no-restricted-syntax, class-methods-use-this, prefer-destructuring */

import winston from 'winston';
import { GuildRoster } from './types';

export const GUILD_LIST_GROUPS = ['Guild Master', 'Admin', 'Staff', 'Bridge', 'Member'] as const;
export type GuildListGroup = (typeof GUILD_LIST_GROUPS)[number];

const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,16}$/;
const MAX_MEMBERS = 500;
const DEFAULT_TIMEOUT_MS = 10_000;
export const GUILD_ROSTER_REFRESH_MS = 10 * 60_000;

export function isValidMinecraftUsername(value: string) {
    return USERNAME_PATTERN.test(value) && value === value.trim();
}

export interface GuildListHeader {
    group: GuildListGroup;
    expected: number;
    rest: string;
}

export interface GuildRosterCollectorOptions {
    sendCommand: (command: string) => void;
    isMinecraftReady: () => boolean;
    now?: () => number;
    timeoutMs?: number;
    cacheMs?: number;
}

interface GroupState {
    expected: number;
    members: string[];
}

interface PendingRoster {
    groups: Map<GuildListGroup, GroupState>;
    members: Map<string, string>;
    currentGroup?: GuildListGroup;
    resolve: (roster: GuildRoster) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export function stripMinecraftFormatting(value: string) {
    // Minecraft formatting is a section sign followed by one formatting code.
    return value.replace(/§#[0-9a-f]{6}/gi, '').replace(/§[0-9a-fk-orx]/gi, '');
}

export function parseGuildListHeader(value: string): GuildListHeader | undefined {
    const clean = stripMinecraftFormatting(value).trim();
    const match = clean.match(
        /^(Guild Master|Admin|Staff|Bridge|Member) \[(\d+)\](?:[ \t]*(.*))?$/
    );
    if (!match) return undefined;
    const expected = Number(match[2]);
    if (!Number.isSafeInteger(expected) || expected < 0 || expected > MAX_MEMBERS) return undefined;
    return {
        group: match[1] as GuildListGroup,
        expected,
        rest: match[3]?.trim() ?? '',
    };
}

function removeRankTags(value: string) {
    return value
        .replace(/\[[^\]\r\n]{1,64}\]/g, '')
        .trim()
        .replace(/\s+♲$/u, '');
}

export function extractGuildListUsernames(value: string) {
    const clean = stripMinecraftFormatting(value).trim();
    if (!clean || /^Guild\s*(?:>|»)/u.test(clean)) return [];
    const segments = clean.split(/\s*[•●]\s*/u);
    const names: string[] = [];
    for (const segment of segments) {
        const candidate = removeRankTags(segment);
        if (!segment.trim()) continue;
        if (!USERNAME_PATTERN.test(candidate)) return [];
        names.push(candidate);
    }
    return names;
}

function cloneRoster(roster: GuildRoster): GuildRoster {
    return { ...roster, members: [...roster.members] };
}

export class GuildRosterCollector {
    private readonly sendCommand: (command: string) => void;
    private readonly isMinecraftReady: () => boolean;
    private readonly now: () => number;
    private readonly timeoutMs: number;
    private readonly cacheMs: number;
    private cache?: GuildRoster;
    private pending?: PendingRoster;

    constructor(options: GuildRosterCollectorOptions) {
        this.sendCommand = options.sendCommand;
        this.isMinecraftReady = options.isMinecraftReady;
        this.now = options.now ?? Date.now;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.cacheMs = options.cacheMs ?? GUILD_ROSTER_REFRESH_MS;
    }

    public get inFlight() {
        return Boolean(this.pending);
    }

    public getRoster(forceRefresh = false): Promise<GuildRoster> {
        if (!forceRefresh && this.cache && this.now() - this.cache.observedAt < this.cacheMs) {
            return Promise.resolve(cloneRoster(this.cache));
        }
        this.cache = undefined;
        if (this.pending) {
            return new Promise((resolve, reject) => {
                const pending = this.pending!;
                const previousResolve = pending.resolve;
                const previousReject = pending.reject;
                pending.resolve = (roster) => {
                    previousResolve(roster);
                    resolve(cloneRoster(roster));
                };
                pending.reject = (error) => {
                    previousReject(error);
                    reject(error);
                };
            });
        }
        if (!this.isMinecraftReady()) {
            return Promise.reject(new Error('Minecraft is not connected yet.'));
        }

        let resolvePromise!: (roster: GuildRoster) => void;
        let rejectPromise!: (error: Error) => void;
        const promise = new Promise<GuildRoster>((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        });
        const pending: PendingRoster = {
            groups: new Map(),
            members: new Map(),
            resolve: resolvePromise,
            reject: rejectPromise,
            timer: setTimeout(() => {
                this.failPending('Timed out waiting for the complete Minecraft guild list.');
            }, this.timeoutMs),
        };
        this.pending = pending;
        try {
            this.sendCommand('/g list');
        } catch (error) {
            this.failPending(
                error instanceof Error ? error.message : 'The guild list command failed.'
            );
        }
        return promise.then(cloneRoster);
    }

    public handleMessage(message: string) {
        const pending = this.pending;
        if (!pending || typeof message !== 'string') return;

        for (const line of stripMinecraftFormatting(message).split(/\r?\n/u)) {
            const header = parseGuildListHeader(line);
            if (header) {
                // A requested response must begin at the exact Guild Master header. This
                // prevents ordinary guild chat and join notices from becoming a roster.
                if (pending.groups.size === 0 && header.group !== 'Guild Master') continue;
                if (pending.groups.has(header.group)) {
                    this.failPending(
                        `The Minecraft guild list repeated the ${header.group} group.`
                    );
                    return;
                }
                pending.groups.set(header.group, {
                    expected: header.expected,
                    members: [],
                });
                pending.currentGroup = header.group;
                if (header.rest) this.consumeNames(header.rest, pending);
                if (!this.pending) return;
                if (this.isComplete(pending)) {
                    this.completePending(pending);
                    return;
                }
                continue;
            }
            if (!pending.currentGroup) continue;
            this.consumeNames(line, pending);
            if (!this.pending) return;
            if (this.isComplete(pending)) {
                this.completePending(pending);
                return;
            }
        }
    }

    public disconnected() {
        this.cache = undefined;
        if (this.pending)
            this.failPending('Minecraft disconnected before the guild list completed.');
    }

    public stop() {
        this.disconnected();
    }

    private consumeNames(value: string, pending: PendingRoster) {
        const groupName = pending.currentGroup;
        if (!groupName) return;
        const group = pending.groups.get(groupName);
        if (!group) return;
        const names = extractGuildListUsernames(value);
        if (group.members.length + names.length > group.expected) {
            this.failPending(`The Minecraft ${groupName} group exceeded its declared count.`);
            return;
        }
        for (const name of names) {
            const key = name.toLowerCase();
            if (pending.members.has(key)) {
                this.failPending('The Minecraft guild list contained a duplicate username.');
                return;
            }
            group.members.push(name);
            pending.members.set(key, name);
        }
    }

    private isComplete(pending: PendingRoster) {
        return (
            pending.groups.size === GUILD_LIST_GROUPS.length &&
            GUILD_LIST_GROUPS.every((groupName) => {
                const group = pending.groups.get(groupName);
                return group !== undefined && group.members.length === group.expected;
            })
        );
    }

    private completePending(pending: PendingRoster) {
        if (this.pending !== pending) return;
        const members = GUILD_LIST_GROUPS.flatMap(
            (groupName) => pending.groups.get(groupName)?.members ?? []
        );
        if (members.length > MAX_MEMBERS) {
            this.failPending('The Minecraft guild list exceeded the safe member limit.');
            return;
        }
        clearTimeout(pending.timer);
        this.pending = undefined;
        const guildMaster = pending.groups.get('Guild Master')?.members[0];
        const roster = { members, guildMaster, observedAt: this.now() };
        this.cache = roster;
        winston.info(
            `Guild leaderboard roster verified: ${members.length} members across five ranks.`
        );
        pending.resolve(cloneRoster(roster));
    }

    private failPending(message: string) {
        const pending = this.pending;
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending = undefined;
        this.cache = undefined;
        const error = new Error(message);
        pending.reject(error);
        const counts = [...pending.groups]
            .map(([group, state]) => `${group} ${state.members.length}/${state.expected}`)
            .join(', ');
        winston.warn(
            `Guild roster request failed: ${message} Received ${counts || 'no rank groups'}.`
        );
    }
}
