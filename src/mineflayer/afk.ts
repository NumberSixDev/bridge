import { Bot } from 'mineflayer';
import winston from 'winston';

const SETTLE_MS = 2_000;
const CHECK_MS = 10_000;
const RETRY_MS = 15_000;

// DragSim sends 1.21.4 window titles as NBT chat components. Older versions
// and test clients may use plain strings or JSON text components instead.
function componentText(value: unknown, depth = 0): string {
    if (depth > 5) return '';
    if (typeof value === 'string') {
        if (value.startsWith('{')) {
            try {
                return componentText(JSON.parse(value), depth + 1);
            } catch {
                return '';
            }
        }
        return value;
    }
    if (!value || typeof value !== 'object') return '';
    const component = value as Record<string, unknown>;
    if (component.type === 'string') return componentText(component.value, depth + 1);
    if (component.type === 'compound') return componentText(component.value, depth + 1);
    return componentText(component.text, depth + 1);
}

export function isAfkWindow(window: { title: unknown } | null | undefined) {
    const title = componentText(window?.title)
        .replace(/§[0-9a-fk-or]/gi, '')
        .trim();
    return /^AFK Rewards(?:\s*·\s*\d{1,2}:\d{2})?$/u.test(title);
}

interface AfkOptions {
    bot: Bot;
    isReady: () => boolean;
    sendCommand: () => void;
    now?: () => number;
    setTimer?: (callback: () => void, delay: number) => NodeJS.Timeout;
    clearTimer?: (timer: NodeJS.Timeout | undefined) => void;
}

export default class AfkKeeper {
    private readonly now: () => number;
    private readonly setTimer: (callback: () => void, delay: number) => NodeJS.Timeout;
    private readonly clearTimer: (timer: NodeJS.Timeout | undefined) => void;
    private timer?: NodeJS.Timeout;
    private scheduledAt = 0;
    private nextAttemptAt = 0;
    private started = false;
    private stopped = false;
    private awaitingSpawn = false;
    private needsReenter = false;
    private active = false;

    public constructor(private readonly options: AfkOptions) {
        this.now = options.now ?? Date.now;
        this.setTimer = options.setTimer ?? setTimeout;
        this.clearTimer = options.clearTimer ?? clearTimeout;
    }

    public get isActive() {
        return (
            !this.stopped &&
            !this.awaitingSpawn &&
            !this.needsReenter &&
            this.options.isReady() &&
            isAfkWindow(this.options.bot.currentWindow)
        );
    }

    public start() {
        if (this.started || this.stopped) return;
        this.started = true;
        this.options.bot.on('respawn', this.onRespawn);
        this.options.bot.on('spawn', this.onSpawn);
        this.options.bot.on('windowOpen', this.onWindowOpen);
        this.options.bot.on('windowClose', this.onWindowClose);
        this.schedule(SETTLE_MS);
    }

    public stop() {
        this.stopped = true;
        this.clearTimer(this.timer);
        this.timer = undefined;
        this.options.bot.removeListener('respawn', this.onRespawn);
        this.options.bot.removeListener('spawn', this.onSpawn);
        this.options.bot.removeListener('windowOpen', this.onWindowOpen);
        this.options.bot.removeListener('windowClose', this.onWindowClose);
    }

    private readonly onRespawn = () => {
        this.awaitingSpawn = true;
        this.needsReenter = true;
        this.active = false;
        this.schedule(CHECK_MS);
    };

    private readonly onSpawn = () => {
        this.awaitingSpawn = false;
        this.needsReenter = true;
        this.active = false;
        this.schedule(SETTLE_MS);
    };

    private readonly onWindowOpen = () => {
        if (isAfkWindow(this.options.bot.currentWindow) && !this.awaitingSpawn) {
            this.confirmActive();
            this.schedule(CHECK_MS);
        } else this.schedule(SETTLE_MS);
    };

    private readonly onWindowClose = () => {
        // Menu timer updates can replace the window. Give its replacement time
        // to arrive before deciding AFK ended, without restarting its rewards.
        this.schedule(SETTLE_MS);
    };

    private confirmActive() {
        this.needsReenter = false;
        this.nextAttemptAt = 0;
        if (!this.active) winston.info('AFK Rewards menu is open; maintaining AFK mode.');
        this.active = true;
    }

    private schedule(delay: number) {
        if (this.stopped) return;
        const due = this.now() + delay;
        if (this.timer && this.scheduledAt <= due) return;
        this.clearTimer(this.timer);
        this.scheduledAt = due;
        this.timer = this.setTimer(() => {
            this.timer = undefined;
            this.check();
        }, delay);
        this.timer.unref?.();
    }

    private check() {
        if (this.stopped) return;
        if (!this.options.isReady() || this.awaitingSpawn) {
            this.schedule(CHECK_MS);
            return;
        }
        if (!this.needsReenter && isAfkWindow(this.options.bot.currentWindow)) {
            this.confirmActive();
            this.schedule(CHECK_MS);
            return;
        }
        const remaining = this.nextAttemptAt - this.now();
        if (remaining > 0) {
            this.schedule(remaining);
            return;
        }
        this.active = false;
        this.nextAttemptAt = this.now() + RETRY_MS;
        try {
            this.options.sendCommand();
            winston.info('Sent /afk to restore the AFK Rewards menu.');
        } catch (error) {
            winston.warn('AFK command could not be sent; retrying when connected:', error);
        }
        this.schedule(RETRY_MS);
    }
}
