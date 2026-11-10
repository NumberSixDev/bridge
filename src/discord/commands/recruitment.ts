import { ApplicationCommandOptionType } from 'discord.js';

export default {
    data: {
        name: 'recruitment',
        description: 'Manage guild recruitment applications and settings.',
        options: [
            {
                name: 'panel',
                description: 'Create or refresh the public recruitment settings panel.',
                type: ApplicationCommandOptionType.Subcommand,
            },
            {
                name: 'requirements',
                description: 'Set minimum estimated networth and purse amounts.',
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'networth',
                        description: 'Minimum estimated networth, such as 500M or none.',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                    },
                    {
                        name: 'purse',
                        description: 'Minimum purse, such as 10M or none.',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                    },
                ],
            },
            {
                name: 'auto',
                description: 'Enable or disable automatic acceptance.',
                type: ApplicationCommandOptionType.Subcommand,
                options: [
                    {
                        name: 'enabled',
                        description: 'Whether automatic acceptance should be enabled.',
                        type: ApplicationCommandOptionType.Boolean,
                        required: true,
                    },
                ],
            },
            {
                name: 'status',
                description: 'Show current recruitment settings.',
                type: ApplicationCommandOptionType.Subcommand,
            },
        ],
    },
    recruitmentOnly: true,
    run: async (bridge, interaction) => bridge.recruitment.handleCommand(interaction),
} as Command;
