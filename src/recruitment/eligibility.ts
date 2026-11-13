import BridgeEmbed from '@discord/embed';
import { escapeMarkdown } from 'discord.js';
import { formatAmount } from './amount';
import { evaluateEligibility } from './policy';
import { cleanProfileName } from './presentation';
import { LookupEvidence, RecruitmentSettings } from './types';

function requirement(label: string, value: number | undefined, minimum: number | undefined) {
    const available = value !== undefined && Number.isFinite(value) && value >= 0;
    const amount = available ? formatAmount(value) : 'Unavailable';
    if (minimum === undefined) return `⚪ ${label}: **${amount}** · Minimum not set`;
    let icon = '⚠️';
    if (available) icon = value >= minimum ? '✅' : '❌';
    return `${icon} ${label}: **${amount}** · Minimum **${formatAmount(minimum)}**`;
}

export default function eligibilityEmbed(
    evidence: LookupEvidence,
    settings: RecruitmentSettings,
    now: number,
    elapsedMs: number
) {
    // A check works while auto-accept is off, but preserves its evidence requirements.
    const result = evaluateEligibility(evidence, { ...settings, autoAcceptEnabled: true }, now);
    const quality = evaluateEligibility(
        evidence,
        { autoAcceptEnabled: true, minimumNetworth: 0, minimumPurse: 0 },
        now
    );
    let verdict = '⚠️ Manual review required';
    let color: 'Green' | 'Red' | 'Yellow' = 'Yellow';
    if (settings.minimumNetworth === undefined || settings.minimumPurse === undefined) {
        verdict = '⚠️ Set both guild minimums first';
    } else if (quality.eligible) {
        verdict = result.eligible ? '✅ Eligible to join' : '❌ Not eligible to join';
        color = result.eligible ? 'Green' : 'Red';
    }
    const lines = [
        `**${verdict}**`,
        `Profile: **${escapeMarkdown(cleanProfileName(evidence.profileName))}** (main)`,
        requirement('Networth (includes purse)', evidence.networth, settings.minimumNetworth),
        requirement('Purse', evidence.purse, settings.minimumPurse),
    ];
    if (!quality.eligible) {
        // One concrete reason keeps the report concise; the same full policy governs admission.
        const reason = (quality.reason.split(/(?<=\.)\s+/)[0] ?? quality.reason).slice(0, 240);
        lines.push(`Data check: ${escapeMarkdown(reason)}`);
    }
    if (evidence.profileSavedAt !== undefined && Number.isFinite(evidence.profileSavedAt)) {
        lines.push(`Profile saved: <t:${Math.floor(evidence.profileSavedAt / 1000)}:R>`);
    }
    return new BridgeEmbed()
        .setTitle(`Guild eligibility: ${evidence.username}`)
        .setColor(color)
        .setDescription(lines.join('\n'))
        .setFooter({
            text: `Time Taken to Search: ${(Math.max(0, elapsedMs) / 1000).toFixed(2)}s`,
        });
}
