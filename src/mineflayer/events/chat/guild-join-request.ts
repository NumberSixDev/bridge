export default {
    name: 'chat:guildJoinRequest',
    runOnce: false,
    run: async (bridge, username: string) => {
        bridge.mineflayer.acceptGuildJoinRequest(username);
    },
} as BotEvent;
