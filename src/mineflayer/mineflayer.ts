import env from '@util/env';
import { Bot, createBot } from 'mineflayer';
import winston from 'winston';
import path from 'path';
import loadEvents from '@util/load-events';
import { guildCommand, singleLine } from '@util/guild-chat';
import minecraftPausedMessage from '@util/minecraft-paused';
import Bridge from '../bridge';
import { GuildRosterCollector } from '../leaderboard/roster';
import AfkKeeper, { isDragSimProfileWindow } from './afk';

const CONNECTION_TIMEOUT_MS = 60_000;
const JOIN_DELAY_MS = 2_000;
const READINESS_TIMEOUT_MS = 30_000;
const READINESS_PROBE_TIMEOUT_MS = 5_000;
const READINESS_PROBE_DELAY_MS = 2_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;
const AUTH_RATE_LIMIT_RETRY_MS = 5 * 60_000;
const AUTH_RATE_LIMIT_REASON = 'authentication rate limit (HTTP 429)';
const AUTH_RATE_LIMIT_MESSAGE = /\bStatus code:\s*429\b/i;

function isRateLimitError(error: unknown) {
    if (typeof error === 'object' && error !== null) {
        if (
            ('status' in error && error.status === 429) ||
            ('statusCode' in error && error.statusCode === 429)
        ) {
            return true;
        }
        return (
            'message' in error &&
            typeof error.message === 'string' &&
            AUTH_RATE_LIMIT_MESSAGE.test(error.message)
        );
    }
    return typeof error === 'string' && AUTH_RATE_LIMIT_MESSAGE.test(error);
}

export default class Mineflayer {
    private bot?: Bot;
    private readyState?: { connectedAt: number };
    private stopping = false;
    private reconnectTimer?: NodeJS.Timeout;
    private reminderTimer?: NodeJS.Timeout;
    private joinTimer?: NodeJS.Timeout;
    private stopReadinessProbe?: () => void;
    private removeProfileWatcher?: () => void;
    private afk?: AfkKeeper;
    private connectionTimer?: NodeJS.Timeout;
    private retryAttempt = 0;

    constructor(private readonly createClient: typeof createBot = createBot) {}

    public get username() {
        return this.bot?.username;
    }

    public get isReady() {
        return Boolean(this.readyState && !this.stopping && this.bot);
    }

    public get connectedAt() {
        return this.readyState?.connectedAt ?? null;
    }

    public get isAfkActive() {
        return this.afk?.isActive ?? false;
    }

    public async connect(bridge: Bridge) {
        if (!env.MINECRAFT_ENABLED) throw new Error(minecraftPausedMessage);
        if (this.bot || this.reconnectTimer) return;
        this.stopping = false;
        this.readyState = undefined;
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
            const rateLimited = isRateLimitError(error);
            if (rateLimited)
                winston.warn(`Minecraft client creation failed (${AUTH_RATE_LIMIT_REASON}).`);
            else winston.error('Minecraft client creation failed:', error);
            this.scheduleReconnect(bridge, rateLimited);
            return;
        }
        this.bot = bot;
        const onProfileWindow = (window: Bot['currentWindow']) => {
            if (
                this.bot !== bot ||
                !this.isReady ||
                window !== bot.currentWindow ||
                !isDragSimProfileWindow(window)
            ) {
                return;
            }
            const joinCommand = env.MINECRAFT_JOIN_COMMAND;
            if (!joinCommand) {
                this.recoverConnection(
                    bot,
                    bridge,
                    'DragSim profile selector requires a join command'
                );
                return;
            }
            this.clearReadyState(bridge);
            winston.warn(
                'DragSim returned the bot to profile selection; rejoining on the same connection.'
            );
            this.scheduleJoin(bot, bridge, joinCommand);
        };
        bot.on('windowOpen', onProfileWindow);
        this.removeProfileWatcher = () => bot.off('windowOpen', onProfileWindow);
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
            const rateLimited = isRateLimitError(error);
            if (!rateLimited) winston.error('Minecraft connection error:', error);
            this.recoverConnection(
                bot,
                bridge,
                rateLimited ? AUTH_RATE_LIMIT_REASON : 'connection error',
                {
                    rateLimited,
                }
            );
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
            this.recoverConnection(bot, bridge, reason, { close: false });
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

    private recoverConnection(
        bot: Bot,
        bridge: Bridge,
        reason: string,
        { close = true, rateLimited = false } = {}
    ) {
        if (this.bot !== bot) return;
        this.bot = undefined;
        this.clearProfileWatcher();
        this.clearReadyState(bridge);
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
        this.scheduleReconnect(bridge, rateLimited);
    }

    private scheduleReconnect(bridge: Bridge, rateLimited = false) {
        if (this.stopping || this.reconnectTimer || this.bot) return;
        const delay = rateLimited
            ? AUTH_RATE_LIMIT_RETRY_MS
            : Math.min(RETRY_BASE_MS * 2 ** Math.min(this.retryAttempt, 4), RETRY_MAX_MS);
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
        this.stopReadinessProbe?.();
        this.stopReadinessProbe = undefined;
        this.connectionTimer = undefined;
        this.joinTimer = undefined;
        this.reminderTimer = undefined;
    }

    private clearProfileWatcher() {
        this.removeProfileWatcher?.();
        this.removeProfileWatcher = undefined;
    }

    private clearReadyState(bridge?: Bridge) {
        this.readyState = undefined;
        this.clearConnectionTimers();
        this.afk?.stop();
        this.afk = undefined;
        bridge?.leaderboard?.onMinecraftDisconnected();
        bridge?.purge?.onMinecraftDisconnected();
    }

    private async onSpawn(bot: Bot, bridge: Bridge) {
        await loadEvents(path.join(__dirname, 'events/chat'), bot, bridge);
        if (this.bot !== bot || this.stopping) return;
        bot.on('messagestr', (message: string) =>
            bridge.leaderboard?.handleMinecraftMessage(message)
        );
        bot.on('messagestr', (message: string) => bridge.purge?.handleMinecraftMessage(message));
        const joinCommand = env.MINECRAFT_JOIN_COMMAND;
        if (joinCommand) this.scheduleJoin(bot, bridge, joinCommand);
        else await this.onReady(bot, bridge);
    }

    private scheduleJoin(bot: Bot, bridge: Bridge, joinCommand: string) {
        // Let the client settle before leaving DragSim's profile selector.
        this.joinTimer = setTimeout(() => {
            if (this.bot !== bot || this.stopping) return;
            this.joinTimer = undefined;
            try {
                bot.chat(joinCommand);
            } catch (error) {
                winston.error('Minecraft join command failed:', error);
                this.recoverConnection(bot, bridge, 'Join command failed');
                return;
            }
            if (this.bot === bot && !this.stopping) this.startReadinessProbe(bot, bridge);
        }, JOIN_DELAY_MS);
    }

    private startReadinessProbe(bot: Bot, bridge: Bridge) {
        let stopped = false;
        let probeTimer: NodeJS.Timeout | undefined;
        let playGeneration = 0;
        const isInPlay = () =>
            !stopped && this.bot === bot && !this.stopping && bot._client.state === 'play';
        const collector = new GuildRosterCollector({
            isMinecraftReady: isInPlay,
            sendCommand: (command) => bot.chat(command),
            timeoutMs: READINESS_PROBE_TIMEOUT_MS,
        });
        const onMessage = (message: string) => {
            if (isInPlay()) collector.handleMessage(message);
        };
        const onProtocolState = (state: string) => {
            if (state === 'play') return;
            playGeneration += 1;
            collector.disconnected();
        };
        const deadline = setTimeout(() => {
            if (!stopped)
                this.recoverConnection(bot, bridge, 'Minecraft guild readiness timed out');
        }, READINESS_TIMEOUT_MS);
        this.stopReadinessProbe = () => {
            stopped = true;
            clearTimeout(probeTimer);
            clearTimeout(deadline);
            bot.off('messagestr', onMessage);
            bot._client.off('state', onProtocolState);
            collector.stop();
        };
        const probe = async () => {
            if (isInPlay()) {
                const generation = playGeneration;
                const roster = await collector.getRoster(true).catch(() => undefined);
                const username = bot.username?.toLowerCase();
                if (
                    isInPlay() &&
                    generation === playGeneration &&
                    roster?.members.some((member) => member.toLowerCase() === username)
                ) {
                    await this.onReady(bot, bridge);
                    return;
                }
            }
            if (!stopped) probeTimer = setTimeout(probe, READINESS_PROBE_DELAY_MS);
        };
        // A same-world hub warp can move the bot without another spawn. A fresh
        // roster proves the account has reached a world that serves guild commands.
        bot.on('messagestr', onMessage);
        bot._client.on('state', onProtocolState);
        probeTimer = setTimeout(probe, READINESS_PROBE_DELAY_MS);
    }

    private async onReady(bot: Bot, bridge: Bridge) {
        if (this.bot !== bot || this.stopping || this.readyState) return;
        this.clearConnectionTimers();
        this.retryAttempt = 0;
        const readyState = { connectedAt: Date.now() };
        this.readyState = readyState;
        // A profile-selector bounce can invalidate this setup without changing bots.
        const isCurrent = () => this.readyState === readyState;
        try {
            if (env.MINECRAFT_AFK_ENABLED) {
                this.afk?.stop();
                this.afk = new AfkKeeper({
                    bot,
                    isReady: isCurrent,
                    sendCommand: () => this.execute('/afk'),
                });
                this.afk.start();
            }
            winston.info(`Connected to ${env.MINECRAFT_HOST} as ${bot.username}.`);
            await bridge.recruitment?.onMinecraftReady();
            if (!isCurrent()) return;
            await bridge.leaderboard?.onMinecraftReady();
            if (!isCurrent()) return;
            await bridge.purge?.onMinecraftReady();
            if (!isCurrent()) return;
            await bridge.discord.send('The DragSim guild bridge is connected.');
            if (!isCurrent()) return;
            if (env.REMINDER_ENABLED) {
                this.reminderTimer = setInterval(() => {
                    try {
                        this.chat(env.REMINDER_MESSAGE);
                    } catch (error) {
                        winston.warn('Reminder was not sent:', error);
                    }
                }, env.REMINDER_FREQUENCY * 60_000);
            }
        } catch (error) {
            if (!isCurrent()) return;
            winston.error('Minecraft ready setup failed:', error);
            this.recoverConnection(bot, bridge, 'Minecraft ready setup failed');
        }
    }

    public chat(message: string) {
        return this.execute(guildCommand(env.MINECRAFT_CHAT_COMMAND, message));
    }

    public execute(message: string) {
        if (!env.MINECRAFT_ENABLED) throw new Error(minecraftPausedMessage);
        if (!this.isReady || !this.bot)
            throw new Error('Minecraft is not connected yet. Please try again shortly.');
        if (message !== singleLine(message) || message.length > 256 || !message.startsWith('/')) {
            throw new Error('Use one command of at most 256 characters.');
        }
        this.bot.chat(message);
    }

    public stop() {
        this.stopping = true;
        this.clearProfileWatcher();
        this.clearReadyState();
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.bot?.quit('Bridge stopped');
    }
}
