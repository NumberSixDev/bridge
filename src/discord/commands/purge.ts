export default {
    data: {
        name: 'purge',
        description: 'Admin/Guild Master: review members below either recruitment minimum.',
    },
    // The service performs its own fresh role check before acknowledging the command.
    run: async (bridge, interaction) => bridge.purge.handleCommand(interaction),
} as Command;
