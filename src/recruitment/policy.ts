import { LookupEvidence, RecruitmentSettings } from './types';

const MAX_AGE_MS = 5 * 60_000;
const FUTURE_SKEW_MS = 60_000;

export interface EligibilityResult {
    eligible: boolean;
    reason: string;
}

function timestampIssue(label: string, timestamp: number | undefined, now: number) {
    if (timestamp === undefined || !Number.isFinite(timestamp))
        return `${label} timestamp is missing`;
    if (timestamp - now > FUTURE_SKEW_MS) return `${label} timestamp is from the future`;
    if (now - timestamp > MAX_AGE_MS) return `${label} data is older than 5 minutes`;
    return undefined;
}

export function evaluateEligibility(
    evidence: LookupEvidence,
    settings: RecruitmentSettings,
    now: number
): EligibilityResult {
    if (!settings.autoAcceptEnabled)
        return { eligible: false, reason: 'Automatic acceptance is disabled.' };
    if (settings.minimumNetworth === undefined || settings.minimumPurse === undefined) {
        return { eligible: false, reason: 'Both automatic acceptance minimums must be set.' };
    }

    const issues = [...evidence.coverageIssues];
    if (!evidence.identityVerified) issues.push('Profile identity could not be verified.');
    if (evidence.hidden) issues.push('The profile or valuation is private.');
    if (evidence.partial) issues.push('The valuation is incomplete.');
    if ((evidence.unpriced ?? 0) > 0) issues.push('Some inventory items are unpriced.');
    if ((evidence.uncertainValue ?? 0) > 0) issues.push('Some inventory values are uncertain.');
    const timestamps: Array<[string, number | undefined]> = [
        ['Profile', evidence.profileSavedAt],
        ['Networth calculation', evidence.calculatedAt],
        ['Market', evidence.marketObservedAt],
    ];
    timestamps.forEach(([label, timestamp]) => {
        const issue = timestampIssue(label, timestamp, now);
        if (issue) issues.push(issue);
    });
    if (evidence.purse === undefined || !Number.isFinite(evidence.purse)) {
        issues.push('Purse value is missing.');
    }
    if (evidence.networth === undefined || !Number.isFinite(evidence.networth)) {
        issues.push('Networth value is missing.');
    }
    if (issues.length) return { eligible: false, reason: issues.join(' ') };

    if (evidence.networth! < settings.minimumNetworth) {
        return { eligible: false, reason: 'Estimated networth is below the configured minimum.' };
    }
    if (evidence.purse! < settings.minimumPurse) {
        return { eligible: false, reason: 'Purse is below the configured minimum.' };
    }
    return {
        eligible: true,
        reason: 'Both configured minimums were met with complete current data.',
    };
}
