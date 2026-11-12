import env from '@util/env';
import { Bot, createBot } from 'mineflayer';
import winston from 'winston';
import path from 'path';
import loadEvents from '@util/load-events';
import { guildCommand, singleLine } from '@util/guild-chat';
import Bridge from '../bridge';
import AfkKeeper from './afk';

const CONNECTION_TIMEOUT_MS = 60_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

export default class Mineflayer {
    private bot?: Bot;
    private ready = false;
    private stopping = false;
    private reconnectTimer?: NodeJS.Timeout;
    private reminderTimer?: NodeJS.Timeout;
    private joinTimer?: NodeJS.Timeout;
    private afk?: AfkKeeper;
    private connectionTimer?: NodeJS.Timeout;
    private retryAttempt = 0;

    constructor(private readonly createClient: typeof createBot = createBot) {}

    public get username() {
        return this.bot?.username;
    }

    public get isReady() {
        return this.ready && !this.stopping && Boolean(this.bot);
    }

    public async connect(bridge: Bridge) {
        if (this.bot || this.reconnectTimer) return;
        this.stopping = false;
        this.ready = false;
        let bot: Bot;
        try {
            bot = this.createClient({
                username: env.MINECRAFT_EMAIL,
                host: env.MINECRAFT_HOST,
                port: env.MINECRAFT_PORT,
                auth: 'microsoft',
                version: env.MINECRAFT_VERSION,
                profilesFolder: path.resolve('.minecraft-auth'),
                defaultChatPatterns: false,
                // Non-fatal partial particle packets otherwise flood stdout. Fatal
                // protocol/transport errors still reach the error handler below.
                hideErrors: true,
            });
        } catch (error) {
            winston.error('Minecraft client creation failed:', error);
            this.scheduleReconnect(bridge);
            return;
        }
        this.bot = bot;
        // Authentication/DNS can finish after an attempt was retired. Refuse
        // its late socket so it cannot create a second account connection.
        const setSocket = bot._client.setSocket?.bind(bot._client);
        if (setSocket) {
            bot._client.setSocket = (socket) => {
                if (this.bot !== bot || this.stopping) {
                    socket.destroy();
                    return;
                }
                setSocket(socket);
            };
        }
        this.connectionTimer = setTimeout(() => {
            this.recoverConnection(bot, bridge, 'Minecraft login/setup exceeded 60 seconds');
        }, CONNECTION_TIMEOUT_MS);
        // DragSim sends its pack during configuration, before the first spawn.
        // Mineflayer 4.37.1's helper serialises UUID objects as zeroes (#4043).
        // Keep the packet's raw UUID; this headless bridge does not render textures.
        bot._client.on('add_resource_pack', (packet: { uuid: string }) => {
            if (this.bot !== bot || this.stopping) return;
            [3, 0].forEach((result) => {
                bot._client.write('resource_pack_receive', { uuid: packet.uuid, result });
            });
            winston.info('Acknowledged the server resource pack.');
        });
        bot.on('error', (error) => {
            if (this.bot !== bot) return;
            winston.error('Minecraft connection error:', error);
            this.recoverConnection(bot, bridge, 'connection error');
        });
        bot.on('kicked', (reason) => {
            if (this.bot !== bot) return;
            winston.warn(
                `Minecraft disconnected the bot: ${
                    typeof reason === 'string' ? reason : JSON.stringify(reason)
                }`
            );
            this.recoverConnection(bot, bridge, 'server kick');
        });
        bot.on('end', (reason) => {
            this.recoverConnection(bot, bridge, reason, false);
        });
        // Mineflayer's chat plugin is available after the first spawn.
        bot.once('spawn', () => {
            if (this.bot !== bot || this.stopping) return;
            this.onSpawn(bot, bridge).catch((error: unknown) => {
                winston.error('Minecraft setup failed:', error);
                this.recoverConnection(bot, bridge, 'Minecraft setup failed');
            });
        });
    }

    private recoverConnection(bot: Bot, bridge: Bridge, reason: string, close = true) {
        if (this.bot !== bot) return;
        this.bot = undefined;
        this.ready = false;
        this.clearConnectionTimers();
        this.afk?.stop();
        this.afk = undefined;
        bridge.leaderboard?.onMinecraftDisconnected();
        bridge.purge?.onMinecraftDisconnected();
        // An authentication failure can have no socket and never emit 'end'.
        // Retire and retry independently of that event, exactly once per attempt.
        if (close) {
            try {
                bot.end(reason);
            } catch (error) {
                winston.warn('Failed to close retired Minecraft client:', error);
            }
            bot._client.socket?.destroy();
        }
        if (!this.stopping) winston.warn(`Minecraft connection retired (${reason}).`);
        this.scheduleReconnect(bridge);
    }

    private scheduleReconnect(bridge: Bridge) {
        if (this.stopping || this.reconnectTimer || this.bot) return;
        const delay = Math.min(RETRY_BASE_MS * 2 ** Math.min(this.retryAttempt, 4), RETRY_MAX_MS);
        this.retryAttempt += 1;
        winston.warn(`Retrying Minecraft connection in ${delay / 1_000} seconds.`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (this.stopping) return;
            this.connect(bridge).catch((error: unknown) => {
                winston.error('Minecraft reconnect failed:', error);
                this.scheduleReconnect(bridge);
            });
        }, delay);
    }

    private clearConnectionTimers() {
        clearTimeout(this.connectionTimer);
        clearTimeout(this.joinTimer);
        clearInterval(this.reminderTimer);
        this.connectionTimer = undefined;
        this.joinTimer = undefined;
        this.reminderTimer = undefined;
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
                        this.recoverConnection(bot, bridge, 'Minecraft hub setup failed');
                    });
                });
                this.joinTimer = setTimeout(() => {
                    this.recoverConnection(bot, bridge, 'Hub transfer timed out');
                }, 15_000);
                try {
                    bot.chat(env.MINECRAFT_JOIN_COMMAND);
                } catch (error) {
                    winston.error('Minecraft join command failed:', error);
                    this.recoverConnection(bot, bridge, 'Join command failed');
                }
            }, 2_000);
            return;
        }
        await this.onReady(bot, bridge);
    }

    private async onReady(bot: Bot, bridge: Bridge) {
        if (this.bot !== bot || this.stopping) return;
        this.clearConnectionTimers();
        this.retryAttempt = 0;
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
        if (this.bot !== bot || this.stopping) return;
        await bridge.leaderboard?.onMinecraftReady();
        if (this.bot !== bot || this.stopping) return;
        await bridge.purge?.onMinecraftReady();
        if (this.bot !== bot || this.stopping) return;
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
        this.clearConnectionTimers();
        this.bot?.quit('Bridge stopped');
    }
}
