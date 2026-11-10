import env from './env';

export default function isStaffCommandChannel(interaction: {
    guildId: string | null;
    channelId: string | null;
}) {
    return (
        interaction.guildId === env.DISCORD_SERVER_ID &&
        interaction.channelId === env.STAFF_COMMAND_CHANNEL_ID
    );
}
