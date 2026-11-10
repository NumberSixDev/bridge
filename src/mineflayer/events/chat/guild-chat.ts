import { escapeMarkdown } from 'discord.js';

export default {
    name: 'chat:guildChat',
    runOnce: false,
    run: async (
        bridge,
        rank: string | undefined,
        playerName: string,
        guildRole: string | undefined,
        message: string
    ) => {
        // Discord messages stay in Discord; suppress the bot's own relay echo.
        if (playerName.toLowerCase() === bridge.mineflayer.username?.toLowerCase()) return;
        const author = [rank, playerName, guildRole].filter(Boolean).join(' ');
        await bridge.discord.send(`**${escapeMarkdown(author)}:** ${escapeMarkdown(message)}`);
    },
} as BotEvent;
