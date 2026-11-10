export type ApplicationStatus =
    | 'pending'
    | 'accepting'
    | 'acceptance-sent'
    | 'denied'
    | 'needs-verification';

export type LookupStatus = 'pending' | 'complete' | 'manual' | 'error';

export interface RecruitmentSettings {
    autoAcceptEnabled: boolean;
    revision?: number;
    minimumNetworth?: number;
    minimumPurse?: number;
    panelMessageId?: string;
    panelChannelId?: string;
}

export interface ApplicationDecision {
    kind: 'manual-accept' | 'automatic-accept' | 'deny';
    actorId?: string;
    decidedAt: number;
    note?: string;
}

export interface ApplicationRecord {
    id: string;
    username: string;
    usernameKey: string;
    receivedAt: number;
    status: ApplicationStatus;
    lookupStatus: LookupStatus;
    playerUuid?: string;
    profileId?: string;
    profileName?: string;
    profileSavedAt?: number;
    calculatedAt?: number;
    marketObservedAt?: number;
    purse?: number;
    networth?: number;
    partial?: boolean;
    hidden?: boolean;
    unpriced?: number;
    uncertainValue?: number;
    coverageIssues: string[];
    evaluationReason?: string;
    deliveryIssue?: string;
    decision?: ApplicationDecision;
    thresholdNetworth?: number;
    thresholdPurse?: number;
    thresholdAutoEnabled: boolean;
    autoCandidate: boolean;
    settingsRevision?: number;
    channelId?: string;
    messageId?: string;
}

export interface RecruitmentState {
    version: 1;
    settings: RecruitmentSettings;
    applications: ApplicationRecord[];
}

export interface LookupEvidence {
    username: string;
    playerUuid?: string;
    profileId?: string;
    profileName?: string;
    profileSavedAt?: number;
    calculatedAt?: number;
    marketObservedAt?: number;
    purse?: number;
    networth?: number;
    partial?: boolean;
    hidden?: boolean;
    unpriced?: number;
    uncertainValue?: number;
    identityVerified: boolean;
    coverageIssues: string[];
}

export interface LookupClient {
    lookup(username: string): Promise<LookupEvidence>;
}

export interface RecruitmentStore {
    load(): RecruitmentState;
    save(state: RecruitmentState): Promise<void>;
}

export function createDefaultRecruitmentState(): RecruitmentState {
    return {
        version: 1,
        settings: { autoAcceptEnabled: false },
        applications: [],
    };
}
