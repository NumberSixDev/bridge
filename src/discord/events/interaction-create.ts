import { ApplicationCommandOptionType, EmbedBuilder, Interaction } from 'discord.js';
import winston from 'winston';
import env from '@util/env';

export default {
    name: 'interactionCreate',
    runOnce: false,
    run: async (bridge, interaction: Interaction) => {
        if (!interaction.inCachedGuild() || interaction.guildId !== env.DISCORD_SERVER_ID) return;

        const isButton = typeof interaction.isButton === 'function' && interaction.isButton();
        const isModalSubmit =
            typeof interaction.isModalSubmit === 'function' && interaction.isModalSubmit();
        if (isButton || isModalSubmit) {
            if (!bridge.recruitment.ownsInteraction(interaction)) return;
            try {
                if (!(await bridge.recruitment.authoriseInteraction(interaction))) {
                    await interaction.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setColor('Red')
                                .setDescription(
                                    'You do not have permission to use recruitment controls.'
                                ),
                        ],
                        ephemeral: true,
                    });
                    return;
                }
                await bridge.recruitment.handleInteraction(interaction);
            } catch (error) {
                winston.error('Recruitment interaction failed:', error);
                const content = 'There was an error while handling that recruitment control.';
                if (interaction.replied || interaction.deferred)
                    await interaction.editReply({ content });
                else await interaction.reply({ content, ephemeral: true });
            }
            return;
        }

        if (!interaction.isChatInputCommand()) return;
        const command = bridge.discord.commands.get(interaction.commandName);
        if (!command) return;
        try {
            if (
                command.recruitmentOnly &&
                !(await bridge.recruitment.authoriseInteraction(interaction))
            ) {
                await interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor('Red')
                            .setDescription(
                                'You do not have permission to use recruitment controls.'
                            ),
                    ],
                    ephemeral: true,
                });
                return;
            }
        } catch (error) {
            winston.error('Recruitment role check failed:', error);
            await interaction.reply({
                content: 'Recruitment permissions could not be verified.',
                ephemeral: true,
            });
            return;
        }
        if (
            command.staffOnly &&
            interaction.user.id !== env.BOT_OWNER_ID &&
            !interaction.member.roles.cache.has(env.STAFF_ROLE_ID)
        ) {
            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor('Red')
                        .setDescription('You do not have permission to run that command.'),
                ],
                ephemeral: true,
            });
            return;
        }
        const args: unknown[] = [];
        interaction.options.data.forEach((option) => {
            if (option.value !== undefined) args.push(option.value);
            if (option.type === ApplicationCommandOptionType.Subcommand && option.options) {
                option.options.forEach((subOption) => {
                    if (subOption.value !== undefined) args.push(subOption.value);
                });
            }
        });
        try {
            await command.run(bridge, interaction, args);
        } catch (error) {
            winston.error(`Command ${interaction.commandName} failed:`, error);
            const content = 'There was an error while executing this command.';
            if (interaction.replied || interaction.deferred)
                await interaction.editReply({ content });
            else await interaction.reply({ content, ephemeral: true });
        }
    },
} as BotEvent;
