import { formatAmount } from './amount';
import { evaluateEligibility } from './policy';
import { ApplicationRecord, RecruitmentSettings } from './types';

export function cleanProfileName(name: string | undefined, fallback = 'Unknown'): string {
    return (
        name
            ?.replace(/§#[0-9a-f]{6}/gi, '')
            .replace(/§[0-9a-fk-orx]/gi, '')
            .trim() || fallback
    );
}

function requirementLine(label: string, value: number | undefined, minimum: number | undefined) {
    if (minimum === undefined) return `${label} = **Minimum not set**`;
    let status = 'Unavailable';
    if (value !== undefined && Number.isFinite(value)) {
        status = value >= minimum ? 'Meets requirement' : 'Under requirement';
    }
    return `${label} = **${status}** (min: ${formatAmount(minimum)})`;
}

export function applicationReport(
    application: ApplicationRecord,
    settings: RecruitmentSettings,
    now: number
): string[] {
    const evidence = {
        ...application,
        identityVerified: Boolean(application.playerUuid && application.profileId),
    };
    // Advice is useful even while automatic acceptance is disabled. Reuse the
    // same data-quality checks without changing the actual admission policy.
    const quality = evaluateEligibility(
        evidence,
        { autoAcceptEnabled: true, minimumNetworth: 0, minimumPurse: 0 },
        now
    );
    const result = evaluateEligibility(evidence, { ...settings, autoAcceptEnabled: true }, now);
    let suggestion = 'Set minimums';
    if (settings.minimumNetworth !== undefined && settings.minimumPurse !== undefined) {
        if (!quality.eligible) suggestion = 'Manual review (verify data)';
        else suggestion = result.eligible ? 'Accept' : 'Below minimums (manual review)';
    }
    return [
        requirementLine('Networth', application.networth, settings.minimumNetworth),
        requirementLine('Purse', application.purse, settings.minimumPurse),
        `Suggestion = **${suggestion}**`,
    ];
}
