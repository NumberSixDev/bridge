import { GuildRoster, LeaderboardDataset } from '../leaderboard/types';
import { RecruitmentSettings } from '../recruitment/types';

export type PurgeBaseStatus = 'eligible' | 'review' | 'protected';
export type PurgeRowStatus = PurgeBaseStatus | 'excluded';

export interface PurgeRow {
    username: string;
    status: PurgeRowStatus;
    baseStatus: PurgeBaseStatus;
    networth?: number;
    purse?: number;
    networthApproximate?: boolean;
    dataAgeMs?: number;
    reason?: string;
}

export interface PurgeExclusionStore {
    load(guildId: string): string[];
    save(guildId: string, usernames: string[]): Promise<void>;
}

export interface PurgeDatasetSnapshot {
    roster: GuildRoster;
    dataset: LeaderboardDataset;
}

export interface PurgeSettingsSnapshot {
    settings: RecruitmentSettings;
    revision: number;
}
