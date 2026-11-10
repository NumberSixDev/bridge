import { ApplicationCommandOptionType } from 'discord.js';

export default {
    data: {
        name: 'eligibility',
        description: 'Admin/Guild Master: check a player against the guild entry requirements.',
        options: [
            {
                name: 'username',
                description: 'Minecraft username to check, including players outside the guild.',
                type: ApplicationCommandOptionType.String,
                required: true,
                minLength: 1,
                maxLength: 16,
            },
        ],
    },
    recruitmentOnly: true,
    run: async (bridge, interaction) => bridge.recruitment.handleEligibilityCommand(interaction),
} as Command;
