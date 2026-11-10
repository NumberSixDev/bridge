export default {
    data: {
        name: 'refresh',
        description: 'Refresh the guild member list, player stats and networth for leaderboards.',
    },
    run: async (bridge, interaction) => bridge.leaderboard.handleRefresh(interaction),
} as Command;
