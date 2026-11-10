const { test } = require('node:test');
const assert = require('node:assert/strict');

const SERVER = '12345678901234567';
const STAFF_CHANNEL = '12345678901234568';
const OTHER_CHANNEL = '12345678901234569';
Object.assign(process.env, {
    MINECRAFT_EMAIL: 'bridge@example.test',
    DISCORD_TOKEN: 'test-token',
    DISCORD_SERVER_ID: SERVER,
    MEMBER_CHANNEL_ID: OTHER_CHANNEL,
    STAFF_COMMAND_CHANNEL_ID: STAFF_CHANNEL,
    BOT_OWNER_ID: '12345678901234570',
    STAFF_ROLE_ID: '12345678901234571',
});

const router = require('../dist/src/discord/events/interaction-create.js').default;
const { envSchema } = require('../dist/src/util/config.js');

function interaction(overrides = {}) {
    const replies = [];
    return {
        guildId: SERVER,
        channelId: STAFF_CHANNEL,
        user: { id: process.env.BOT_OWNER_ID },
        member: { roles: { cache: { has: () => true } } },
        options: { data: [] },
        inCachedGuild: () => true,
        isChatInputCommand: () => true,
        isButton: () => false,
        isModalSubmit: () => false,
        isStringSelectMenu: () => false,
        replies,
        reply: async (payload) => replies.push(payload),
        ...overrides,
    };
}

test('every restricted command requires the staff channel, even for the owner; public commands stay public', async () => {
    for (const name of [
        'command',
        'slowmode',
        'terminate',
        'recruitment',
        'purge',
        'help',
        'gleaderboard',
        'refresh',
    ]) {
        const definition = require(`../dist/src/discord/commands/${name}.js`).default;
        const restricted = !['help', 'gleaderboard', 'refresh'].includes(name);
        let runs = 0;
        let roleChecks = 0;
        const bridge = {
            discord: { commands: new Map([[name, { ...definition, run: async () => runs++ }]]) },
            recruitment: {
                authoriseInteraction: async () => {
                    roleChecks++;
                    return true;
                },
            },
        };
        const outside = interaction({ commandName: name, channelId: OTHER_CHANNEL });
        await router.run(bridge, outside);
        assert.equal(runs, restricted ? 0 : 1, name);
        assert.equal(roleChecks, 0, 'wrong-channel denial happens before any role/API work');
        if (restricted) {
            assert.equal(outside.replies[0].ephemeral, true);
            assert.ok(outside.replies[0].content.includes(`<#${STAFF_CHANNEL}>`));
        }
        const inside = interaction({ commandName: name });
        await router.run(bridge, inside);
        assert.equal(runs, restricted ? 1 : 2, name);
        assert.equal(inside.replies.length, 0);
    }
});

test('old management buttons, modals and purge selectors cannot run outside the staff channel', async () => {
    const calls = [];
    const bridge = {
        recruitment: {
            ownsInteraction: (value) => value.customId.startsWith('recruitment:'),
            authoriseInteraction: async () => {
                calls.push('role');
                return true;
            },
            handleInteraction: async () => calls.push('recruitment'),
        },
        purge: {
            ownsInteraction: (value) => value.customId.startsWith('purge:'),
            handleInteraction: async () => calls.push('purge'),
        },
    };
    for (const [customId, type] of [
        ['recruitment:panel:edit', 'button'],
        ['recruitment:panel:auto:enable', 'button'],
        ['recruitment:panel:requirements', 'modal'],
        ['purge:session:open', 'button'],
        ['purge:session:confirm:nonce', 'button'],
        ['purge:session:select', 'select'],
    ]) {
        const options = {
            customId,
            isChatInputCommand: () => false,
            isButton: () => type === 'button',
            isModalSubmit: () => type === 'modal',
            isStringSelectMenu: () => type === 'select',
        };
        calls.length = 0;
        const outside = interaction({ ...options, channelId: OTHER_CHANNEL });
        await router.run(bridge, outside);
        assert.deepEqual(calls, [], customId);
        assert.equal(outside.replies[0].ephemeral, true);
        assert.ok(outside.replies[0].content.includes(`<#${STAFF_CHANNEL}>`));
        await router.run(bridge, interaction(options));
        assert.equal(calls.at(-1), customId.startsWith('purge:') ? 'purge' : 'recruitment');
    }
});

test('application review buttons keep their existing authorisation and channel/message checks', async () => {
    let allowed = true;
    let checks = 0;
    let handled = 0;
    const bridge = {
        recruitment: {
            ownsInteraction: (value) => value.customId.startsWith('recruitment:'),
            authoriseInteraction: async () => {
                checks++;
                return allowed;
            },
            handleInteraction: async () => handled++,
        },
    };
    for (const action of ['accept', 'deny']) {
        const options = {
            customId: `recruitment:application:application-id:${action}`,
            channelId: OTHER_CHANNEL,
            isChatInputCommand: () => false,
            isButton: () => true,
        };
        allowed = true;
        await router.run(bridge, interaction(options));
        assert.equal(handled, action === 'accept' ? 1 : 2);
        allowed = false;
        const denied = interaction(options);
        await router.run(bridge, denied);
        assert.equal(handled, action === 'accept' ? 1 : 2);
        assert.equal(denied.replies[0].ephemeral, true);
    }
    assert.equal(checks, 4);
});

test('staff channel configuration accepts only a valid channel ID', () => {
    assert.equal(envSchema.safeParse(process.env).success, true);
    for (const value of ['', 'any', '123']) {
        assert.equal(
            envSchema.safeParse({ ...process.env, STAFF_COMMAND_CHANNEL_ID: value }).success,
            false
        );
    }
});
