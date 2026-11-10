import { IntentsBitField } from 'discord.js';
import winston from 'winston';
import env from '@util/env';
import Discord from '@discord/discord';
import Mineflayer from '@mineflayer/mineflayer';

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
        this.mineflayer.stop();
        this.discord.destroy();
    }

    private async start() {
        await Promise.all([this.discord.loadCommands(), this.discord.loadEvents(this)]);
        await this.discord.login(env.DISCORD_TOKEN);
    }
}
