import { ApplicationCommandOptionType, EmbedBuilder, Interaction } from 'discord.js';
import winston from 'winston';
import env from '@util/env';
import isStaffCommandChannel from '@util/staff-command-channel';

export default {
    name: 'interactionCreate',
    runOnce: false,
    run: async (bridge, interaction: Interaction) => {
        if (!interaction.inCachedGuild() || interaction.guildId !== env.DISCORD_SERVER_ID) return;

        if (typeof interaction.isAutocomplete === 'function' && interaction.isAutocomplete()) {
            if (interaction.commandName !== 'gleaderboard') return;
            try {
                if (bridge.leaderboard) await bridge.leaderboard.handleAutocomplete(interaction);
            } catch (error) {
                winston.error('Leaderboard autocomplete failed:', error);
            }
            return;
        }

        const isButton = typeof interaction.isButton === 'function' && interaction.isButton();
        const isModalSubmit =
            typeof interaction.isModalSubmit === 'function' && interaction.isModalSubmit();
        const isStringSelectMenu =
            typeof interaction.isStringSelectMenu === 'function' &&
            interaction.isStringSelectMenu();
        if (isButton || isModalSubmit || isStringSelectMenu) {
            const restrictedControl =
                bridge.purge?.ownsInteraction(interaction) ||
                (bridge.recruitment?.ownsInteraction(interaction) &&
                    !interaction.customId.startsWith('recruitment:application:'));
            if (restrictedControl && !isStaffCommandChannel(interaction)) {
                await interaction.reply({
                    content: `Use staff controls in <#${env.STAFF_COMMAND_CHANNEL_ID}>. Run the command there to open a new panel.`,
                    ephemeral: true,
                });
                return;
            }
            if (isButton && bridge.leaderboard?.ownsInteraction(interaction)) {
                try {
                    await bridge.leaderboard.handleInteraction(interaction);
                } catch (error) {
                    winston.error('Leaderboard interaction failed:', error);
                    if (interaction.replied || interaction.deferred)
                        await interaction.followUp({
                            content: 'There was an error while handling that leaderboard control.',
                            ephemeral: true,
                        });
                    else
                        await interaction.reply({
                            content: 'There was an error while handling that leaderboard control.',
                            ephemeral: true,
                        });
                }
                return;
            }
            if ((isButton || isStringSelectMenu) && bridge.purge?.ownsInteraction(interaction)) {
                try {
                    await bridge.purge.handleInteraction(interaction);
                } catch (error) {
                    winston.error('Purge interaction failed:', error);
                    const content = 'There was an error while handling that purge control.';
                    if (interaction.replied || interaction.deferred)
                        await interaction.editReply({ content });
                    else await interaction.reply({ content, ephemeral: true });
                }
                return;
            }
            if (!bridge.recruitment.ownsInteraction(interaction)) return;
            const isApplicationButton =
                isButton && interaction.customId.startsWith('recruitment:application:');
            try {
                // Acknowledge the card click before the fresh role lookup; authorisation
                // and stored message/channel checks still run before any decision.
                if (isApplicationButton) await interaction.deferUpdate();
                if (!(await bridge.recruitment.authoriseInteraction(interaction))) {
                    const denial = {
                        embeds: [
                            new EmbedBuilder()
                                .setColor('Red')
                                .setDescription(
                                    'You do not have permission to use recruitment controls.'
                                ),
                        ],
                        ephemeral: true,
                    };
                    if (isApplicationButton) await interaction.followUp(denial);
                    else await interaction.reply(denial);
                    return;
                }
                await bridge.recruitment.handleInteraction(interaction);
            } catch (error) {
                winston.error('Recruitment interaction failed:', error);
                const content = 'There was an error while handling that recruitment control.';
                if (isApplicationButton && (interaction.replied || interaction.deferred))
                    await interaction.followUp({ content, ephemeral: true });
                else if (interaction.replied || interaction.deferred)
                    await interaction.editReply({ content });
                else await interaction.reply({ content, ephemeral: true });
            }
            return;
        }

        if (!interaction.isChatInputCommand()) return;
        const command = bridge.discord.commands.get(interaction.commandName);
        if (!command) return;
        if (
            (command.staffOnly || command.recruitmentOnly || command.staffChannelOnly) &&
            !isStaffCommandChannel(interaction)
        ) {
            await interaction.reply({
                content: `Use this command in <#${env.STAFF_COMMAND_CHANNEL_ID}>.`,
                ephemeral: true,
            });
            return;
        }
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
