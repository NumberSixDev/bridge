import { escapeMarkdown } from 'discord.js';

export default {
    name: 'chat:guildChat',
    runOnce: false,
    run: async (bridge, rank: string | undefined, playerName: string, message: string) => {
        // Discord messages stay in Discord; suppress the bot's own relay echo.
        if (playerName.toLowerCase() === bridge.mineflayer.username?.toLowerCase()) return;
        const author = rank ? `${rank} ${playerName}` : playerName;
        await bridge.discord.send(`**${escapeMarkdown(author)}:** ${escapeMarkdown(message)}`);
    },
} as BotEvent;
