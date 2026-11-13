import BridgeEmbed from '@discord/embed';

export default {
    data: {
        name: 'help',
        description: 'View a list of all commands!',
    },
    run: async (bridge, interaction) => {
        const embed = new BridgeEmbed().setColor('Purple').setTitle('Commands');

        bridge.discord.commands.forEach((command) => {
            embed.addFields({
                name: command.data.name,
                value: command.data.description ?? 'No description.',
            });
        });

        await interaction.reply({ embeds: [embed] });
    },
} as Command;
