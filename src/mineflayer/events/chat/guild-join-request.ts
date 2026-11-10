export default {
    name: 'chat:guildJoinRequest',
    runOnce: false,
    run: async (bridge, username: string) => {
        if (bridge.recruitment) await bridge.recruitment.handleJoinRequest(username);
    },
} as BotEvent;
