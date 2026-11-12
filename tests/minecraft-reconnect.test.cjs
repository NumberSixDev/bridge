const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

Object.assign(process.env, {
    MINECRAFT_EMAIL: 'bridge@example.test',
    DISCORD_TOKEN: 'test-token',
    DISCORD_SERVER_ID: '12345678901234567',
    MEMBER_CHANNEL_ID: '12345678901234568',
    MINECRAFT_JOIN_COMMAND: '',
    MINECRAFT_AFK_ENABLED: 'false',
    REMINDER_ENABLED: 'false',
});
const Mineflayer = require('../dist/src/mineflayer/mineflayer.js').default;
const runtimeEnv = require('../dist/src/util/env.js').default;

function harness({ creationFailures = 0 } = {}) {
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const timers = new Set();
    global.setTimeout = (callback, delay) => {
        const timer = { callback, delay };
        timers.add(timer);
        return timer;
    };
    global.clearTimeout = (timer) => timers.delete(timer);
    const clients = [];
    const events = { attempts: 0, leaderboardDisconnects: 0, purgeDisconnects: 0, ready: 0 };
    const bridge = {
        leaderboard: {
            onMinecraftDisconnected: () => events.leaderboardDisconnects++,
            onMinecraftReady: async () => {},
        },
        purge: {
            onMinecraftDisconnected: () => events.purgeDisconnects++,
            onMinecraftReady: async () => {},
        },
        discord: { send: async () => events.ready++ },
    };
    const service = new Mineflayer((options) => {
        events.attempts++;
        if (events.attempts <= creationFailures) throw Error('Client creation failed');
        const bot = new EventEmitter();
        bot._client = new EventEmitter();
        bot._client.setSocket = (socket) => {
            bot._client.socket = socket;
        };
        bot.username = 'TestBot';
        bot.options = options;
        bot.commands = [];
        bot.chat = (text) => bot.commands.push(text);
        bot.addChatPattern = () => {};
        // Reproduce the incident: before a socket exists end() emits nothing.
        bot.end = (reason) => {
            bot.endReason = reason;
        };
        bot.quit = (reason) => {
            bot.quitReason = reason;
        };
        clients.push(bot);
        return bot;
    });
    function timer(delay) {
        const result = [...timers].find((item) => item.delay === delay);
        assert.ok(result, `Missing ${delay}ms timer`);
        return result;
    }
    async function fire(delay) {
        const item = timer(delay);
        timers.delete(item);
        await item.callback();
    }
    function close() {
        service.stop();
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
    }
    return { service, bridge, clients, events, timers, timer, fire, close };
}

test('pre-socket authentication errors retry without needing an end event, once per attempt', async () => {
    const h = harness();
    try {
        await h.service.connect(h.bridge);
        const failed = h.clients[0];
        assert.equal(failed.options.hideErrors, true);
        failed.emit('error', Error('Failed to obtain profile data'));
        assert.equal(h.service.isReady, false);
        assert.equal(h.service.bot, undefined);
        assert.equal(h.events.leaderboardDisconnects, 1);
        assert.equal(h.events.purgeDisconnects, 1);
        failed.emit('end', 'late close');
        failed.emit('error', Error('late error'));
        assert.equal(h.timers.size, 1);
        await h.fire(5_000);
        assert.equal(h.clients.length, 2);
        assert.equal(h.service.bot, h.clients[1]);
    } finally {
        h.close();
    }
});

test('a stalled login times out and late sockets or spawn events cannot revive the old client', async () => {
    const h = harness();
    try {
        await h.service.connect(h.bridge);
        const retired = h.clients[0];
        await h.fire(60_000);
        assert.match(retired.endReason, /exceeded 60 seconds/);
        const socket = {
            destroyed: false,
            destroy() {
                this.destroyed = true;
            },
        };
        retired._client.setSocket(socket);
        assert.equal(socket.destroyed, true);
        assert.equal(retired._client.socket, undefined);
        retired.emit('spawn');
        assert.equal(h.events.ready, 0);
        await h.fire(5_000);
        const current = h.clients[1];
        const activeSocket = {
            destroyed: false,
            destroy() {
                this.destroyed = true;
            },
        };
        current._client.setSocket(activeSocket);
        assert.equal(current._client.socket, activeSocket);
        assert.equal(activeSocket.destroyed, false);
        h.service.stop();
        const afterStop = {
            destroyed: false,
            destroy() {
                this.destroyed = true;
            },
        };
        current._client.setSocket(afterStop);
        assert.equal(afterStop.destroyed, true);
    } finally {
        h.close();
    }
});

test('client creation failures keep retrying with bounded backoff and stop cancels it', async () => {
    const h = harness({ creationFailures: 10 });
    try {
        await h.service.connect(h.bridge);
        for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
            assert.equal(h.timers.size, 1);
            await h.fire(delay);
        }
        assert.equal(h.events.attempts, 7);
        const staleCallback = h.timer(60_000).callback;
        h.service.stop();
        assert.equal(h.timers.size, 0);
        await staleCallback();
        assert.equal(h.events.attempts, 7);
    } finally {
        h.close();
    }
});

test('successful readiness clears its watchdog and resets the retry backoff', async () => {
    const h = harness();
    try {
        await h.service.connect(h.bridge);
        h.clients[0].emit('kicked', 'try later');
        await h.fire(5_000);
        h.clients[1].emit('error', Error('temporary login failure'));
        await h.fire(10_000);
        const current = h.clients[2];
        await h.service.onReady(current, h.bridge);
        assert.equal(h.service.isReady, true);
        assert.equal(h.timers.size, 0);
        assert.equal(h.events.ready, 1);
        current.emit('end', 'network lost');
        h.timer(5_000);
        assert.equal(h.service.isReady, false);
    } finally {
        h.close();
    }
});

test('hub transfer timeout also retries when the client never emits end', async () => {
    const previous = runtimeEnv.MINECRAFT_JOIN_COMMAND;
    runtimeEnv.MINECRAFT_JOIN_COMMAND = '/warp hub';
    const h = harness();
    try {
        await h.service.connect(h.bridge);
        const failed = h.clients[0];
        await h.service.onSpawn(failed, h.bridge);
        await h.fire(2_000);
        assert.deepEqual(failed.commands, ['/warp hub']);
        await h.fire(15_000);
        assert.match(failed.endReason, /Hub transfer timed out/);
        assert.equal(h.timers.size, 1);
        await h.fire(5_000);
        assert.equal(h.clients.length, 2);
    } finally {
        h.close();
        runtimeEnv.MINECRAFT_JOIN_COMMAND = previous;
    }
});
