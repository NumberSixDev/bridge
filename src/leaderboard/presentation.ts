import { escapeMarkdown } from 'discord.js';

// eslint-disable-next-line import/prefer-default-export
export function playerLabel(username: string, rank?: string) {
    const clean = rank?.trim().toUpperCase();
    const visible =
        clean &&
        !['DEFAULT', 'NONE', 'UNRANKED'].includes(clean) &&
        /^[A-Z0-9_+ -]{1,32}$/.test(clean)
            ? clean.replaceAll('_PLUS', '+').replaceAll('_', ' ')
            : undefined;
    return `${visible ? `${escapeMarkdown(`[${visible}]`)} ` : ''}${escapeMarkdown(username)}`;
}
