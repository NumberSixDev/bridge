const { test } = require('node:test');
const assert = require('node:assert/strict');

// Set valid values before loading any compiled module that imports util/env.
Object.assign(process.env, {
    MINECRAFT_EMAIL: 'bridge@example.test',
    DISCORD_TOKEN: 'test-token',
    DISCORD_SERVER_ID: '12345678901234567',
    MEMBER_CHANNEL_ID: '12345678901234568',
    BOT_OWNER_ID: '',
    STAFF_ROLE_ID: '',
    USE_PROFANITY_FILTER: 'false',
    USE_FIRST_WORD_OF_AUTHOR_NAME: 'false',
    MINECRAFT_HOST: 'dragsim.co',
    MINECRAFT_VERSION: '1.21.4',
    MINECRAFT_CHAT_COMMAND: '/gc',
    MINECRAFT_JOIN_COMMAND: '',
    REMINDER_ENABLED: 'false',
    DISCORD_IGNORE_PREFIX: ')',
});

const {
    GUILD_CHAT_PATTERN,
    singleLine,
    formatGuildMessage,
    guildCommand,
} = require('../dist/src/util/guild-chat.js');
const guildChat = require('../dist/src/mineflayer/events/chat/guild-chat.js').default;
const discordMessage = require('../dist/src/discord/events/message.js').default;
const interactionCreate = require('../dist/src/discord/events/interaction-create.js').default;
const Mineflayer = require('../dist/src/mineflayer/mineflayer.js').default;
const { envSchema } = require('../dist/src/util/config.js');
const winston = require('winston');

test('parses ranked and unranked guild messages while excluding other chat', () => {
    assert.deepEqual('Guild > [DRAGON] LabGeek: .'.match(GUILD_CHAT_PATTERN).slice(1), [
        '[DRAGON]',
        'LabGeek',
        '.',
    ]);
    assert.deepEqual('Guild > LabGeek: hello'.match(GUILD_CHAT_PATTERN).slice(1), [
        undefined,
        'LabGeek',
        'hello',
    ]);
    for (const text of [
        'Officer > [DRAGON] LabGeek: hello',
        'LabGeek: hello',
        'Guild > LabGeek joined',
    ]) {
        assert.equal(GUILD_CHAT_PATTERN.test(text), false, text);
    }
});

test('sanitises newlines and enforces Minecraft command length including prefix', () => {
    assert.equal(singleLine('a\r\nb\t§c'), 'a b c');
    assert.equal(formatGuildMessage('LabGeek', 'one\ntwo', '>'), 'LabGeek > one two');
    assert.equal(guildCommand('/gc', 'hello\nworld'), '/gc hello world');
    assert.throws(() => guildCommand('/gc', 'x'.repeat(253)), /256 characters/);
    assert.equal(guildCommand('/gc', 'x'.repeat(250)).length, 254);
    const withAuthor = formatGuildMessage('LabGeek', 'x'.repeat(240), '>');
    assert.equal(guildCommand('/gc', withAuthor).length, 254);
    assert.equal(
        guildCommand('/gc', formatGuildMessage('LabGeek', 'x'.repeat(241), '>')).length,
        255
    );
    assert.equal(
        guildCommand('/gc', formatGuildMessage('LabGeek', 'x'.repeat(242), '>')).length,
        256
    );
    assert.throws(
        () => guildCommand('/gc', formatGuildMessage('LabGeek', 'x'.repeat(243), '>')),
        /256 characters/
    );
});

test('guild relay sends ranked author and ignores own Minecraft echo', async () => {
    const sent = [];
    const bridge = {
        mineflayer: { username: 'LabGeek' },
        discord: { send: (value) => sent.push(value) },
    };
    await guildChat.run(bridge, '[DRAGON]', 'OtherPlayer', 'hello');
    await guildChat.run(bridge, undefined, 'LabGeek', 'own echo');
    assert.deepEqual(sent, ['**[DRAGON] OtherPlayer:** hello']);
});

test('Discord relay enforces guild/channel boundaries, ignores bots and webhooks, and never deletes messages', async () => {
    const calls = [];
    const bridge = { mineflayer: { chat: (text) => calls.push(text) } };
    const makeMessage = (overrides = {}) => ({
        guildId: '12345678901234567',
        channelId: '12345678901234568',
        author: { bot: false },
        webhookId: null,
        content: 'hello',
        cleanContent: 'hello',
        member: { displayName: 'Lab Geek' },
        reply: async () => calls.push('reply'),
        delete: async () => calls.push('delete'),
        ...overrides,
    });
    for (const m of [
        makeMessage({ guildId: '99999999999999999' }),
        makeMessage({ channelId: '99999999999999999' }),
        makeMessage({ author: { bot: true } }),
        makeMessage({ webhookId: 'webhook' }),
    ])
        await discordMessage.run(bridge, m);
    const valid = makeMessage();
    await discordMessage.run(bridge, valid);
    assert.deepEqual(calls, ['Lab Geek > hello']);
});

test('message formatting failures are replied to without deleting the Discord message', async () => {
    const calls = [];
    const bridge = {
        mineflayer: {
            chat: () => {
                throw new Error('send failed');
            },
        },
    };
    const message = {
        guildId: '12345678901234567',
        channelId: '12345678901234568',
        author: { bot: false },
        webhookId: null,
        content: 'hello',
        cleanContent: 'hello',
        member: { displayName: 'LabGeek' },
        reply: async (payload) => calls.push(payload),
        delete: async () => calls.push('delete'),
    };
    await discordMessage.run(bridge, message);
    assert.equal(calls.length, 1);
    assert.match(calls[0].content, /send failed/);
    assert.equal(calls[0].allowedMentions.repliedUser, false);
});

test('staff commands are denied when staff IDs are blank and async errors are caught', async () => {
    const replies = [];
    let invocationCount = 0;
    const bridge = {
        discord: {
            commands: new Map([
                [
                    'staff',
                    {
                        staffOnly: true,
                        run: async () => {
                            invocationCount++;
                        },
                    },
                ],
                [
                    'broken',
                    {
                        run: async () => {
                            throw new Error('expected');
                        },
                    },
                ],
            ]),
        },
    };
    const interaction = (name) => ({
        commandName: name,
        guildId: '12345678901234567',
        user: { id: '99999999999999999' },
        member: { roles: { cache: { has: (id) => id !== '' } } },
        options: { data: [] },
        isChatInputCommand: () => true,
        inCachedGuild: () => true,
        reply: async (payload) => replies.push(payload),
    });
    await interactionCreate.run(bridge, interaction('staff'));
    assert.equal(invocationCount, 0);
    assert.equal(replies[0].ephemeral, true);

    const originalError = winston.error;
    winston.error = () => {};
    try {
        await interactionCreate.run(bridge, interaction('broken'));
    } finally {
        winston.error = originalError;
    }
    assert.equal(replies[1].content, 'There was an error while executing this command.');
    assert.equal(replies[1].ephemeral, true);
});

test('configuration requires credentials and valid single-guild IDs and chat command', () => {
    const valid = {
        MINECRAFT_EMAIL: 'bridge@example.test',
        DISCORD_TOKEN: 'test-token',
        DISCORD_SERVER_ID: '12345678901234567',
        MEMBER_CHANNEL_ID: '12345678901234568',
        BOT_OWNER_ID: '',
        STAFF_ROLE_ID: '',
    };
    const parsed = envSchema.safeParse(valid);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.BOT_OWNER_ID, '');
    assert.equal(parsed.data.STAFF_ROLE_ID, '');
    assert.equal(Object.hasOwn(parsed.data, 'HYPIXEL_API_KEY'), false);
    assert.equal(Object.hasOwn(parsed.data, 'OFFICER_CHANNEL_ID'), false);
    assert.equal(envSchema.safeParse({ ...valid, MINECRAFT_EMAIL: '' }).success, false);
    assert.equal(envSchema.safeParse({ ...valid, DISCORD_TOKEN: '' }).success, false);
    assert.equal(envSchema.safeParse({ ...valid, MEMBER_CHANNEL_ID: 'bad-id' }).success, false);
    assert.equal(envSchema.safeParse({ ...valid, MINECRAFT_CHAT_COMMAND: 'gc' }).success, false);
    assert.equal(
        envSchema.safeParse({ ...valid, MINECRAFT_JOIN_COMMAND: '/warp hub\n/other' }).success,
        false
    );
});

test('guild chat waits for the configured hub transfer after the first spawn', async () => {
    const { EventEmitter } = require('node:events');
    const runtimeEnv = require('../dist/src/util/env.js').default;
    const originalJoinCommand = runtimeEnv.MINECRAFT_JOIN_COMMAND;
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    let joinCallback;
    let joinScheduled;
    let ready;
    let watchdogCleared = false;
    const scheduled = new Promise((resolve) => {
        joinScheduled = resolve;
    });
    const connected = new Promise((resolve) => {
        ready = resolve;
    });
    global.setTimeout = (callback, delay, ...args) => {
        if (delay === 2_000) {
            joinCallback = callback;
            joinScheduled();
            return { joinDelay: true };
        }
        if (delay === 15_000) return { joinWatchdog: true };
        return originalSetTimeout(callback, delay, ...args);
    };
    global.clearTimeout = (timer) => {
        if (timer?.joinWatchdog) watchdogCleared = true;
        else if (!timer?.joinDelay) originalClearTimeout(timer);
    };
    runtimeEnv.MINECRAFT_JOIN_COMMAND = '/warp hub';
    const bot = new EventEmitter();
    bot._client = new EventEmitter();
    bot.username = 'LabGeek2';
    bot.addChatPattern = () => {};
    bot.quit = () => {};
    const chats = [];
    bot.chat = (text) => chats.push(text);
    const mineflayer = new Mineflayer(() => bot);
    try {
        await mineflayer.connect({ discord: { send: async () => ready() }, stop() {} });
        bot.emit('spawn');
        await scheduled;
        assert.throws(() => mineflayer.chat('too early'), /not connected yet/);
        joinCallback();
        assert.deepEqual(chats, ['/warp hub']);
        assert.throws(() => mineflayer.chat('still transferring'), /not connected yet/);
        bot.emit('spawn');
        await connected;
        assert.equal(watchdogCleared, true);
        mineflayer.chat('ready');
        assert.deepEqual(chats, ['/warp hub', '/gc ready']);
    } finally {
        mineflayer.stop();
        runtimeEnv.MINECRAFT_JOIN_COMMAND = originalJoinCommand;
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
    }
});

test('resource pack replies preserve each UUID on the 1.21.4 wire before spawn', async () => {
    const { EventEmitter } = require('node:events');
    const protocol = require(require.resolve('minecraft-protocol', {
        paths: [require.resolve('mineflayer')],
    }));
    const serializer = protocol.createSerializer({ state: 'configuration', version: '1.21.4' });
    const replies = [];
    const bot = new EventEmitter();
    bot._client = new EventEmitter();
    bot._client.write = (name, params) => {
        replies.push(serializer.createPacketBuffer({ name, params }));
    };
    bot.quit = () => {};
    const mineflayer = new Mineflayer(() => bot);
    await mineflayer.connect({ discord: { send: async () => {} }, stop() {} });
    for (const uuid of [
        'f81d4fae-7dec-11d0-a765-00a0c91e6bf6',
        'a95c5314-9c4c-4b32-b802-7b80fd471133',
    ]) {
        bot._client.emit('add_resource_pack', { uuid });
        const [accepted, loaded] = replies.splice(0);
        const expectedId = Buffer.from(uuid.replaceAll('-', ''), 'hex');
        assert.ok(accepted.includes(expectedId), 'acceptance must carry the server pack ID');
        assert.ok(loaded.includes(expectedId), 'completion must carry the same pack ID');
        assert.equal(accepted.at(-1), 3);
        assert.equal(loaded.at(-1), 0);
    }
    assert.throws(() => mineflayer.chat('before spawn'), /not connected yet/);
    mineflayer.stop();
});

test('Mineflayer starts only on connect, waits for spawn, sends /gc, deduplicates retry and stop cancels it', async () => {
    const { EventEmitter } = require('node:events');
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const retryCallbacks = [];
    let retryCleared = false;
    global.setTimeout = (callback) => {
        const timer = { fakeRetry: true };
        retryCallbacks.push({ callback, timer });
        return timer;
    };
    global.clearTimeout = (timer) => {
        if (timer?.fakeRetry) retryCleared = true;
    };
    try {
        const clients = [];
        class FakeBot extends EventEmitter {
            _client = new EventEmitter();
            username = 'LabGeek';
            chats = [];
            patterns = [];
            addChatPattern(name, pattern, options) {
                this.patterns.push({ name, pattern, options });
            }
            chat(text) {
                this.chats.push(text);
            }
            end(reason) {
                this.endReason = reason;
                this.emit('end', reason);
            }
            quit(reason) {
                this.quitReason = reason;
            }
        }
        const mineflayer = new Mineflayer((options) => {
            const bot = new FakeBot();
            bot.options = options;
            clients.push(bot);
            return bot;
        });
        assert.equal(clients.length, 0, 'constructor must not connect');
        let markReady;
        const ready = new Promise((resolve) => {
            markReady = resolve;
        });
        const bridge = {
            discord: {
                send: async () => {
                    markReady();
                },
            },
            stop() {},
        };
        assert.throws(() => mineflayer.chat('before spawn'), /not connected yet/);
        await mineflayer.connect(bridge);
        assert.equal(clients.length, 1);
        assert.throws(() => mineflayer.chat('before spawn'), /not connected yet/);
        const bot = clients[0];
        bot.emit('spawn');
        await ready;
        assert.deepEqual(bot.patterns, [
            {
                name: 'guildChat',
                pattern: GUILD_CHAT_PATTERN,
                options: { repeat: true, parse: true },
            },
        ]);
        mineflayer.chat('LabGeek > hello');
        assert.deepEqual(bot.chats, ['/gc LabGeek > hello']);
        bot.emit('error', new Error('offline'));
        bot.emit('end', 'again');
        assert.equal(retryCallbacks.length, 1, 'error and end must schedule only one retry');
        mineflayer.stop();
        assert.equal(retryCleared, true);
        assert.equal(clients.length, 1, 'stop must prevent retry connection');

        let loadingPatterns;
        const patternsRegistered = new Promise((resolve) => {
            loadingPatterns = resolve;
        });
        const racingMineflayer = new Mineflayer(() => {
            const racingBot = new FakeBot();
            const addChatPattern = racingBot.addChatPattern.bind(racingBot);
            racingBot.addChatPattern = (...args) => {
                addChatPattern(...args);
                loadingPatterns();
            };
            clients.push(racingBot);
            return racingBot;
        });
        let racedReady = false;
        const racingBridge = {
            discord: {
                send: async () => {
                    racedReady = true;
                },
            },
            stop() {},
        };
        await racingMineflayer.connect(racingBridge);
        const racingBot = clients[1];
        racingBot.emit('spawn');
        racingBot.emit('end', 'disconnected during loading');
        await patternsRegistered;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(
            racedReady,
            false,
            'a disconnected bot must not become ready after event loading'
        );
        assert.throws(() => racingMineflayer.chat('too soon'), /not connected yet/);
        assert.equal(retryCallbacks.length, 2, 'the disconnected bot gets exactly one retry');
        racingMineflayer.stop();
        assert.equal(retryCleared, true);
    } finally {
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
    }
});
