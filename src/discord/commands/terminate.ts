import { EmbedBuilder } from 'discord.js';
import winston from 'winston';

export default {
    data: { name: 'terminate', description: 'Stop the current bridge session.' },
    run: async (bridge, interaction) => {
        await interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor('Green')
                    .setTitle('Stopped')
                    .setDescription('The bridge session has stopped.'),
            ],
        });
        winston.info(`Session stopped by ${interaction.user.username}`);
        bridge.stop();
    },
    staffOnly: true,
} as Command;
