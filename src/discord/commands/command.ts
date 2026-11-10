import { ApplicationCommandOptionType, EmbedBuilder } from 'discord.js';

export default {
    data: {
        name: 'command',
        description: 'Send a command through the Minecraft bot.',
        options: [
            {
                name: 'command',
                description: 'The Minecraft command to send',
                type: ApplicationCommandOptionType.String,
                required: true,
            },
        ],
    },
    run: async (bridge, interaction, args) => {
        const input = args[0] as string;
        const command = input.startsWith('/') ? input : `/${input}`;
        const embed = new EmbedBuilder();
        try {
            bridge.mineflayer.execute(command);
            embed
                .setColor('Green')
                .setTitle('Sent')
                .setDescription(
                    'The command was sent to Minecraft. This does not confirm the server accepted it.'
                );
        } catch (error) {
            embed
                .setColor('Red')
                .setTitle('Not sent')
                .setDescription(
                    error instanceof Error ? error.message : 'The command could not be sent.'
                );
        }
        await interaction.reply({ embeds: [embed], ephemeral: true });
    },
    staffOnly: true,
} as Command;
