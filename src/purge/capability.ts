import { stripMinecraftFormatting } from '../leaderboard/roster';

export type GuildKickSyntax = 'g' | 'guild';

const HELP_ENTRY =
    /^(?:\/(g|guild)\s+kick\s+(?:<[^>\r\n]{1,32}>|\[[^\]\r\n]{1,32}\]|(?:player|username|name)))(?:\s|$)/i;
const PREFIXED_HELP_ENTRY =
    /^(?:commands?|guild commands?|usage|help)\s*[:>-]\s*(?:\/(g|guild)\s+kick\s+(?:<[^>\r\n]{1,32}>|\[[^\]\r\n]{1,32}\]|(?:player|username|name)))(?:\s|$)/i;

export function parseKickCapabilityHelpLine(value: string): GuildKickSyntax | undefined {
    const clean = stripMinecraftFormatting(value).trim();
    if (!clean || /^Guild\s*(?:>|»)/u.test(clean)) return undefined;
    const match = clean.match(HELP_ENTRY) ?? clean.match(PREFIXED_HELP_ENTRY);
    return match?.[1]?.toLowerCase() as GuildKickSyntax | undefined;
}
