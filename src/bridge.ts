import { IntentsBitField } from 'discord.js';
import winston from 'winston';
import env from '@util/env';
import Discord from '@discord/discord';
import Mineflayer from '@mineflayer/mineflayer';
import RecruitmentService from './recruitment/service';

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
    public readonly recruitment = new RecruitmentService({
        getChannel: () => this.discord.memberChannel,
        isMinecraftReady: () => this.mineflayer.isReady,
        sendAcceptance: (username) => this.mineflayer.execute(`/g accept ${username}`),
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
        this.recruitment.stop();
        this.mineflayer.stop();
        this.discord.destroy();
    }

    private async start() {
        await Promise.all([this.discord.loadCommands(), this.discord.loadEvents(this)]);
        await this.discord.login(env.DISCORD_TOKEN);
    }
}
