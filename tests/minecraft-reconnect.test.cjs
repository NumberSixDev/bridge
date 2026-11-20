const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

Object.assign(process.env, {
    MINECRAFT_ENABLED: 'true',
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

function harness({
    creationFailures = 0,
    creationError = Error('Client creation failed'),
    joinCommand = '',
} = {}) {
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const previousJoinCommand = runtimeEnv.MINECRAFT_JOIN_COMMAND;
    runtimeEnv.MINECRAFT_JOIN_COMMAND = joinCommand;
    const timers = new Set();
    let joinScheduled;
    global.setTimeout = (callback, delay) => {
        const timer = { callback, delay };
        timers.add(timer);
        if (delay === 2_000) joinScheduled?.();
        return timer;
    };
    global.clearTimeout = (timer) => timers.delete(timer);
    const clients = [];
    const events = { attempts: 0, leaderboardDisconnects: 0, purgeDisconnects: 0, ready: 0 };
    const bridge = {
        leaderboard: {
            onMinecraftDisconnected: () => events.leaderboardDisconnects++,
            onMinecraftReady: async () => {},
            handleMinecraftMessage: () => {},
        },
        purge: {
            onMinecraftDisconnected: () => events.purgeDisconnects++,
            onMinecraftReady: async () => {},
            handleMinecraftMessage: () => {},
        },
        discord: { send: async () => events.ready++ },
    };
    const service = new Mineflayer((options) => {
        events.attempts++;
        if (events.attempts <= creationFailures) throw creationError;
        const bot = new EventEmitter();
        bot._client = new EventEmitter();
        bot._client.state = 'play';
        bot.setProtocolState = (state) => {
            const previous = bot._client.state;
            bot._client.state = state;
            bot._client.emit('state', state, previous);
        };
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
    async function startJoin() {
        const bot = clients.at(-1);
        const scheduled = new Promise((resolve) => {
            joinScheduled = resolve;
        });
        bot.emit('spawn');
        await scheduled;
        joinScheduled = undefined;
        await fire(2_000);
        return bot;
    }
    function close() {
        service.stop();
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
        runtimeEnv.MINECRAFT_JOIN_COMMAND = previousJoinCommand;
    }
    return { service, bridge, clients, events, timers, timer, fire, startJoin, close };
}

const roster = (member = 'tEsTbOt') =>
    `Guild Name: Test (1/2 online)\nGuild Master [1] Owner\nMember [1] ${member}`;

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

test('a position-only hub warp becomes ready only after a fresh complete roster', async () => {
    const h = harness({ joinCommand: '/warp hub' });
    try {
        await h.service.connect(h.bridge);
        const bot = await h.startJoin();
        assert.deepEqual(bot.commands, ['/warp hub']);
        bot.emit('move');
        bot.emit('messagestr', roster());
        assert.equal(h.service.isReady, false);
        const attempted = h.fire(2_000);
        assert.deepEqual(bot.commands, ['/warp hub', '/g list']);
        assert.equal(h.service.isReady, false);
        bot.emit('messagestr', roster());
        await attempted;
        assert.equal(h.service.isReady, true);
        assert.equal(h.events.ready, 1);
        assert.equal(h.timers.size, 0);
        assert.equal(bot.listenerCount('messagestr'), 2);
        assert.equal(bot._client.listenerCount('state'), 0);
        bot.emit('messagestr', roster());
        bot.emit('spawn');
        assert.equal(h.events.ready, 1);
    } finally {
        h.close();
    }
});

test('guild readiness retries across respawn and discards probe results from a prior play state', async () => {
    const h = harness({ joinCommand: '/warp hub' });
    try {
        await h.service.connect(h.bridge);
        const bot = await h.startJoin();
        const interrupted = h.fire(2_000);
        bot.emit('messagestr', 'Guild Name: Test (1/2 online)\nGuild Master [1] Owner');
        bot.setProtocolState('configuration');
        assert.equal(
            [...h.timers].some(({ delay }) => delay === 5_000),
            false
        );
        bot.emit('respawn');
        bot.emit('messagestr', 'Member [1] TestBot');
        await interrupted;
        await h.fire(2_000);
        assert.deepEqual(bot.commands, ['/warp hub', '/g list']);
        assert.equal(h.service.isReady, false);

        bot.setProtocolState('play');
        bot.emit('spawn');
        assert.equal(h.service.isReady, false);
        const raced = h.fire(2_000);
        bot.emit('messagestr', roster());
        bot.setProtocolState('configuration');
        bot.setProtocolState('play');
        await raced;
        assert.equal(h.service.isReady, false);

        const verified = h.fire(2_000);
        bot.emit('messagestr', roster());
        await verified;
        assert.deepEqual(bot.commands, ['/warp hub', '/g list', '/g list', '/g list']);
        assert.equal(h.events.ready, 1);
        assert.equal(h.service.isReady, true);
    } finally {
        h.close();
    }
});

test('partial or foreign rosters never ready the bot and guild readiness has a deadline', async () => {
    const h = harness({ joinCommand: '/warp hub' });
    try {
        await h.service.connect(h.bridge);
        const failed = await h.startJoin();
        assert.deepEqual(failed.commands, ['/warp hub']);
        const partial = h.fire(2_000);
        failed.emit('messagestr', 'Guild Name: Test (1/2 online)\nGuild Master [1] TestBot');
        await h.fire(5_000);
        await partial;
        assert.equal(h.service.isReady, false);
        const foreign = h.fire(2_000);
        failed.emit('messagestr', roster('SomebodyElse'));
        await foreign;
        assert.equal(h.service.isReady, false);

        const interrupted = h.fire(2_000);
        await h.fire(30_000);
        await interrupted;
        assert.match(failed.endReason, /guild readiness timed out/);
        assert.equal(failed.listenerCount('messagestr'), 2);
        assert.equal(failed._client.listenerCount('state'), 0);
        assert.equal(h.timers.size, 1);
        await h.fire(5_000);
        assert.equal(h.clients.length, 2);
        const replacement = await h.startJoin();
        const replacing = h.fire(2_000);
        failed.emit('messagestr', roster());
        failed.emit('end', 'late close');
        assert.equal(h.service.isReady, false);
        replacement.emit('messagestr', roster());
        await replacing;
        assert.equal(h.events.ready, 1);
    } finally {
        h.close();
    }
});

test('stop clears a pending readiness probe and ignores its late response', async () => {
    const h = harness({ joinCommand: '/warp hub' });
    try {
        await h.service.connect(h.bridge);
        const bot = await h.startJoin();
        const attempted = h.fire(2_000);
        const staleDeadline = h.timer(30_000).callback;
        h.service.stop();
        bot.emit('messagestr', roster());
        await attempted;
        await staleDeadline();
        assert.equal(h.service.isReady, false);
        assert.equal(h.events.ready, 0);
        assert.equal(h.timers.size, 0);
        assert.equal(bot.listenerCount('messagestr'), 2);
        assert.equal(bot._client.listenerCount('state'), 0);
        assert.equal(bot.endReason, undefined);
    } finally {
        h.close();
    }
});

test('HTTP 429 login errors use a five-minute cooldown and stop cancels it', async () => {
    const h = harness({ creationFailures: 1, creationError: { status: 429 } });
    try {
        await h.service.connect(h.bridge);
        assert.equal(h.timers.size, 1);
        await h.fire(300_000);
        h.clients[0].emit('error', { statusCode: 429 });
        assert.equal(h.timers.size, 1);
        await h.fire(300_000);
        h.clients[1].emit('error', Error('Response is not JSON. Status code: 429'));
        assert.equal(h.timers.size, 1);
        await h.fire(300_000);
        await h.service.onReady(h.clients[2], h.bridge);
        h.clients[2].emit('end', 'network lost');
        await h.fire(5_000);
        h.clients[3].emit('error', 'Response is not JSON. Status code: 429');
        const staleCooldown = h.timer(300_000).callback;
        h.service.stop();
        await staleCooldown();
        assert.equal(h.timers.size, 0);
        assert.equal(h.events.attempts, 5);
    } finally {
        h.close();
    }
});
