import env from '@util/env';
import { Bot, createBot } from 'mineflayer';
import winston from 'winston';
import path from 'path';
import loadEvents from '@util/load-events';
import { guildCommand, singleLine } from '@util/guild-chat';
import Bridge from '../bridge';
import AfkKeeper from './afk';

export default class Mineflayer {
    private bot?: Bot;
    private ready = false;
    private stopping = false;
    private reconnectTimer?: NodeJS.Timeout;
    private reminderTimer?: NodeJS.Timeout;
    private joinTimer?: NodeJS.Timeout;
    private afk?: AfkKeeper;

    constructor(private readonly createClient: typeof createBot = createBot) {}

    public get username() {
        return this.bot?.username;
    }

    public get isReady() {
        return this.ready && !this.stopping && Boolean(this.bot);
    }

    public async connect(bridge: Bridge) {
        this.stopping = false;
        this.ready = false;
        const bot = this.createClient({
            username: env.MINECRAFT_EMAIL,
            host: env.MINECRAFT_HOST,
            port: env.MINECRAFT_PORT,
            auth: 'microsoft',
            version: env.MINECRAFT_VERSION,
            profilesFolder: path.resolve('.minecraft-auth'),
            defaultChatPatterns: false,
        });
        this.bot = bot;
        // DragSim sends its pack during configuration, before the first spawn.
        // Mineflayer 4.37.1's helper serialises UUID objects as zeroes (#4043).
        // Keep the packet's raw UUID; this headless bridge does not render textures.
        bot._client.on('add_resource_pack', (packet: { uuid: string }) => {
            [3, 0].forEach((result) => {
                bot._client.write('resource_pack_receive', { uuid: packet.uuid, result });
            });
            winston.info('Acknowledged the server resource pack.');
        });
        bot.on('error', (error) => {
            winston.error('Minecraft connection error:', error);
            if (this.bot === bot) bot.end('connection error');
        });
        bot.on('kicked', (reason) => {
            winston.warn(
                `Minecraft disconnected the bot: ${
                    typeof reason === 'string' ? reason : JSON.stringify(reason)
                }`
            );
        });
        bot.on('end', (reason) => {
            if (this.bot !== bot) return;
            this.bot = undefined;
            this.ready = false;
            this.afk?.stop();
            this.afk = undefined;
            bridge.leaderboard?.onMinecraftDisconnected();
            bridge.purge?.onMinecraftDisconnected();
            clearInterval(this.reminderTimer);
            clearTimeout(this.joinTimer);
            if (this.stopping || this.reconnectTimer) return;
            winston.warn(`Minecraft connection ended (${reason}); reconnecting in 15 seconds.`);
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = undefined;
                this.connect(bridge).catch((error: unknown) => {
                    winston.error('Minecraft reconnect failed:', error);
                    bridge.stop();
                    process.exitCode = 1;
                });
            }, 15_000);
        });
        // Mineflayer's chat plugin is available after the first spawn.
        bot.once('spawn', () => {
            this.onSpawn(bot, bridge).catch((error: unknown) => {
                winston.error('Minecraft setup failed:', error);
                bridge.stop();
                process.exitCode = 1;
            });
        });
    }

    private async onSpawn(bot: Bot, bridge: Bridge) {
        await loadEvents(path.join(__dirname, 'events/chat'), bot, bridge);
        if (this.bot !== bot || this.stopping) return;
        bot.on('messagestr', (message: string) =>
            bridge.leaderboard?.handleMinecraftMessage(message)
        );
        bot.on('messagestr', (message: string) => bridge.purge?.handleMinecraftMessage(message));
        if (env.MINECRAFT_JOIN_COMMAND) {
            // Let DragSim finish its initial profile-selector transfer first.
            this.joinTimer = setTimeout(() => {
                if (this.bot !== bot || this.stopping) return;
                bot.once('spawn', () => {
                    if (this.bot !== bot || this.stopping) return;
                    clearTimeout(this.joinTimer);
                    this.onReady(bot, bridge).catch((error: unknown) => {
                        winston.error('Minecraft hub setup failed:', error);
                        bridge.stop();
                        process.exitCode = 1;
                    });
                });
                this.joinTimer = setTimeout(() => {
                    if (this.bot === bot && !this.stopping) bot.end('Hub transfer timed out');
                }, 15_000);
                try {
                    bot.chat(env.MINECRAFT_JOIN_COMMAND);
                } catch (error) {
                    winston.error('Minecraft join command failed:', error);
                    bot.end('Join command failed');
                }
            }, 2_000);
            return;
        }
        await this.onReady(bot, bridge);
    }

    private async onReady(bot: Bot, bridge: Bridge) {
        if (this.bot !== bot || this.stopping) return;
        this.ready = true;
        if (env.MINECRAFT_AFK_ENABLED) {
            this.afk?.stop();
            this.afk = new AfkKeeper({
                bot,
                isReady: () => this.bot === bot && this.isReady,
                sendCommand: () => this.execute('/afk'),
            });
            this.afk.start();
        }
        winston.info(`Connected to ${env.MINECRAFT_HOST} as ${bot.username}.`);
        await bridge.recruitment?.onMinecraftReady();
        await bridge.leaderboard?.onMinecraftReady();
        await bridge.purge?.onMinecraftReady();
        await bridge.discord.send('The DragSim guild bridge is connected.');
        if (this.bot !== bot || this.stopping) return;
        if (env.REMINDER_ENABLED) {
            this.reminderTimer = setInterval(() => {
                try {
                    this.chat(env.REMINDER_MESSAGE);
                } catch (error) {
                    winston.warn('Reminder was not sent:', error);
                }
            }, env.REMINDER_FREQUENCY * 60_000);
        }
    }

    public chat(message: string) {
        return this.execute(guildCommand(env.MINECRAFT_CHAT_COMMAND, message));
    }

    public execute(message: string) {
        if (!this.ready || !this.bot)
            throw new Error('Minecraft is not connected yet. Please try again shortly.');
        if (message !== singleLine(message) || message.length > 256 || !message.startsWith('/')) {
            throw new Error('Use one command of at most 256 characters.');
        }
        this.bot.chat(message);
    }

    public stop() {
        this.stopping = true;
        this.ready = false;
        this.afk?.stop();
        this.afk = undefined;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        clearInterval(this.reminderTimer);
        clearTimeout(this.joinTimer);
        this.bot?.quit('Bridge stopped');
    }
}
