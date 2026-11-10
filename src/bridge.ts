import { IntentsBitField, TextChannel } from 'discord.js';
import winston from 'winston';
import env from '@util/env';
import Discord from '@discord/discord';
import Mineflayer from '@mineflayer/mineflayer';
import LeaderboardService from './leaderboard/service';
import RecruitmentService from './recruitment/service';
import PurgeService from './purge/service';

export default class Bridge {
    public readonly discord = new Discord({
        allowedMentions: { parse: [], repliedUser: false },
        intents: [
            IntentsBitField.Flags.Guilds,
            IntentsBitField.Flags.GuildMessages,
            IntentsBitField.Flags.MessageContent,
        ],
    });
    public readonly mineflayer = new Mineflayer();
    public readonly leaderboard = new LeaderboardService({
        sendMinecraftCommand: (command) => this.mineflayer.execute(command),
        isMinecraftReady: () => this.mineflayer.isReady,
        dataDir: env.RECRUITMENT_DATA_DIR,
    });
    public readonly recruitment = new RecruitmentService({
        getChannel: () => this.discord.memberChannel,
        resolveChannel: async (id) => {
            const channel = await this.discord.channels.fetch(id);
            if (
                !(channel instanceof TextChannel) ||
                channel.guildId !== env.DISCORD_SERVER_ID ||
                !channel
                    .permissionsFor(this.discord.user!)
                    ?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])
            )
                return undefined;
            return channel;
        },
        isMinecraftReady: () => this.mineflayer.isReady,
        sendAcceptance: (username) => this.mineflayer.execute(`/g accept ${username}`),
    });
    public readonly purge = new PurgeService({
        getSettings: () => this.recruitment.settings,
        authoriseInteraction: (interaction) => this.recruitment.authoriseInteraction(interaction),
        getSnapshot: (forceRoster) => this.leaderboard.getPurgeSnapshot(forceRoster),
        getRoster: (forceRefresh) => this.leaderboard.getRoster(forceRefresh),
        lookupFresh: (username) => this.leaderboard.lookupFreshPurgeEvidence(username),
        isMinecraftReady: () => this.mineflayer.isReady,
        getBotUsername: () => this.mineflayer.username,
        sendMinecraftCommand: (command) => this.mineflayer.execute(command),
        dataDir: env.RECRUITMENT_DATA_DIR,
    });

    constructor() {
        this.start().catch((error: unknown) => {
            winston.error('Bridge startup failed:', error);
            this.stop();
            process.exitCode = 1;
        });
        process.once('SIGINT', () => this.stop());
        process.once('SIGTERM', () => this.stop());
    }

    public stop() {
        this.leaderboard.stop();
        this.recruitment.stop();
        this.purge.stop();
        this.mineflayer.stop();
        this.discord.destroy();
    }

    private async start() {
        await Promise.all([this.discord.loadCommands(), this.discord.loadEvents(this)]);
        await this.discord.login(env.DISCORD_TOKEN);
    }
}
