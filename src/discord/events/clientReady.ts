import { ActivityType, TextChannel } from 'discord.js';
import env from '@util/env';
import winston from 'winston';

export default {
    name: 'clientReady',
    runOnce: true,
    run: async (bridge) => {
        try {
            const channel = await bridge.discord.channels.fetch(env.MEMBER_CHANNEL_ID);
            if (!(channel instanceof TextChannel) || channel.guildId !== env.DISCORD_SERVER_ID) {
                throw new Error('MEMBER_CHANNEL_ID must be a text channel in DISCORD_SERVER_ID.');
            }
            if (
                !channel
                    .permissionsFor(bridge.discord.user!)
                    ?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])
            ) {
                throw new Error(
                    'The bot needs View Channel, Send Messages and Embed Links in the bridge channel.'
                );
            }
            bridge.discord.memberChannel = channel;
            const registered = await bridge.discord.application!.commands.set(
                bridge.discord.commands.map((command) => command.data),
                env.DISCORD_SERVER_ID
            );
            bridge.recordDiscordCommands(registered.size);
            await bridge.recruitment.onDiscordReady();
            if (!bridge.discord.isReady()) return;
            if (!env.MINECRAFT_ENABLED) {
                bridge.discord.user!.setActivity('Minecraft paused', {
                    type: ActivityType.Watching,
                });
                winston.info('Discord commands are ready. The Minecraft connection is paused.');
                return;
            }
            bridge.discord.user!.setActivity('DragSim guild chat', { type: ActivityType.Watching });
            await bridge.mineflayer.connect(bridge);
        } catch (error) {
            bridge.stop();
            process.exitCode = 1;
            throw error;
        }
    },
} as BotEvent;
