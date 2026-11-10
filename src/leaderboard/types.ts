export const LEADERBOARD_CATEGORIES = [
    'networth',
    'purse',
    'collections',
    'skills',
    'bestiary',
    'slayer',
    'dungeons',
    'mining',
    'currencies',
    'stats',
    'rng',
] as const;

export type LeaderboardCategory = (typeof LEADERBOARD_CATEGORIES)[number];

export type MetricUnit = 'amount' | 'xp' | 'kills' | 'count' | 'level' | 'score' | 'stat';

export interface GuildRoster {
    guildName?: string;
    members: string[];
    observedAt: number;
}

export interface ProfileSnapshot {
    username: string;
    rank?: string;
    uuid: string;
    profileId: string;
    profileName?: string;
    profileSavedAt?: number;
    observedAt: number;
    inventoryHidden: boolean;
    profile: Record<string, unknown>;
}

export interface NetworthSnapshot {
    username: string;
    profileId: string;
    total?: number;
    hidden: boolean;
    partial: boolean;
    calculatedAt?: number;
}

export interface LeaderboardLookupClient {
    getProfile(username: string): Promise<ProfileSnapshot>;
    getNetworth(username: string, profileId: string): Promise<NetworthSnapshot>;
}

export interface MetricDefinition {
    id: string;
    category: LeaderboardCategory;
    label: string;
    unit: MetricUnit;
    default?: boolean;
    extract: (
        profile: ProfileSnapshot,
        networth: NetworthSnapshot | undefined
    ) => number | undefined;
}

export interface RankedPlayer {
    username: string;
    rank?: string;
    value: number;
    approximate?: boolean;
}

export interface LeaderboardSnapshot {
    category: LeaderboardCategory;
    metric: MetricDefinition;
    rows: RankedPlayer[];
    rosterCount: number;
    unavailableCount: number;
    partialCount: number;
    rosterObservedAt: number;
    oldestProfileDataAt?: number;
    snapshotAt: number;
}
