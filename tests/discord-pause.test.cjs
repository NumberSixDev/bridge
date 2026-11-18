const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TextChannel } = require('discord.js');

const SERVER = '12345678901234567';
const CHANNEL = '12345678901234568';
Object.assign(process.env, {
    MINECRAFT_EMAIL: 'bridge@example.test',
    MINECRAFT_ENABLED: 'false',
    DISCORD_TOKEN: 'test-token',
    DISCORD_SERVER_ID: SERVER,
    MEMBER_CHANNEL_ID: CHANNEL,
});

const Discord = require('../dist/src/discord/discord.js').default;
const Mineflayer = require('../dist/src/mineflayer/mineflayer.js').default;
const LeaderboardService = require('../dist/src/leaderboard/service.js').default;
const clientReady = require('../dist/src/discord/events/clientReady.js').default;
const router = require('../dist/src/discord/events/interaction-create.js').default;
const message = require('../dist/src/discord/events/message.js').default;
const gleaderboard = require('../dist/src/discord/commands/gleaderboard.js').default;
const refresh = require('../dist/src/discord/commands/refresh.js').default;

test('paused Discord startup registers the loaded guild commands and skips Minecraft', async () => {
    const discord = new Discord({ intents: [] });
    await discord.loadCommands();
    const channel = Object.assign(Object.create(TextChannel.prototype), {
        guildId: SERVER,
        permissionsFor: () => ({ has: () => true }),
    });
    let registrations;
    let reported;
    let activities;
    let recruitmentReady = 0;
    const bridge = {
        discord: {
            commands: discord.commands,
            channels: { fetch: async () => channel },
            application: {
                commands: {
                    async set(data, guildId) {
                        registrations = { data, guildId };
                        return { size: data.length };
                    },
                },
            },
            isReady: () => true,
            user: { setActivity: (activity) => (activities = activity) },
        },
        recordDiscordCommands: (count) => (reported = count),
        recruitment: { onDiscordReady: async () => recruitmentReady++ },
        mineflayer: {
            connect: async () => assert.fail('Attempted Minecraft connect during pause'),
        },
        stop: () => assert.fail('Stopped Discord during pause'),
    };

    await clientReady.run(bridge);
    assert.equal(bridge.discord.memberChannel, channel);
    assert.equal(registrations.guildId, SERVER);
    assert.equal(reported, discord.commands.size);
    assert.ok(registrations.data.some((command) => command.name === 'gleaderboard'));
    assert.equal(recruitmentReady, 1);
    assert.match(activities, /Minecraft paused/i);
});

test('the paused Minecraft guard rejects direct connection requests without creating a client', async () => {
    let created = 0;
    const mineflayer = new Mineflayer(() => created++);
    await assert.rejects(mineflayer.connect({}), /Minecraft connection is paused/);
    assert.equal(created, 0);
    assert.equal(mineflayer.isReady, false);
    assert.equal(mineflayer.isAfkActive, false);
});

function commandInteraction(commandName, overrides = {}) {
    const actions = [];
    return {
        guildId: SERVER,
        user: { id: 'test-user' },
        commandName,
        options: { data: [], getSubcommand: () => 'networth' },
        inCachedGuild: () => true,
        isChatInputCommand: () => true,
        actions,
        deferReply: async () => actions.push(['defer']),
        editReply: async (reply) => actions.push(['edit', reply]),
        reply: async (reply) => actions.push(['reply', reply]),
        ...overrides,
    };
}

test('paused networth and refresh acknowledge through the real router without Minecraft or API work', async () => {
    const unexpectedCalls = [];
    const leaderboard = new LeaderboardService({
        sendMinecraftCommand: () => unexpectedCalls.push('minecraft'),
        isMinecraftReady: () => false,
        isMinecraftPaused: () => true,
        lookup: {
            getProfile: async () => unexpectedCalls.push('profile'),
            getNetworth: async () => unexpectedCalls.push('networth'),
        },
    });
    // A recent cached roster must also be unavailable during an intentional pause.
    leaderboard.roster.cache = { members: ['Player'], observedAt: Date.now() };
    const bridge = {
        leaderboard,
        discord: {
            commands: new Map([
                ['gleaderboard', gleaderboard],
                ['refresh', refresh],
            ]),
        },
    };
    try {
        for (const name of ['gleaderboard', 'refresh']) {
            const interaction = commandInteraction(name);
            await router.run(bridge, interaction);
            assert.deepEqual(
                interaction.actions.map(([action]) => action),
                ['defer', 'edit']
            );
            assert.match(interaction.actions[1][1].content, /Minecraft connection is paused/);
        }
        assert.deepEqual(unexpectedCalls, []);
    } finally {
        leaderboard.stop();
    }
});

test('the paused relay leaves ordinary Discord guild messages alone', async () => {
    await message.run(
        { mineflayer: { chat: () => assert.fail('Relayed Discord chat during pause') } },
        {
            guildId: SERVER,
            channelId: CHANNEL,
            author: { bot: false },
            content: 'Test',
            cleanContent: 'Test',
            member: { displayName: 'Member' },
            reply: async () => assert.fail('Tried to reply to guild chat during pause'),
        }
    );
});

test('configured-guild slash commands receive private fallbacks without access to services', async () => {
    const bridge = {
        discord: {
            commands: new Map([
                [
                    'staff',
                    { recruitmentOnly: true, run: async () => assert.fail('Ran staff command') },
                ],
            ]),
        },
        recruitment: { authoriseInteraction: async () => assert.fail('Looked up staff roles') },
    };
    const uncached = commandInteraction('staff', { inCachedGuild: () => false });
    await router.run(bridge, uncached);
    assert.equal(uncached.actions[0][1].ephemeral, true);
    assert.match(uncached.actions[0][1].content, /waiting for Discord guild data/);

    const unknown = commandInteraction('old-command');
    await router.run(bridge, unknown);
    assert.equal(unknown.actions[0][1].ephemeral, true);
    assert.match(unknown.actions[0][1].content, /command is unavailable/);

    const outside = commandInteraction('staff', { guildId: 'other-guild' });
    await router.run(bridge, outside);
    assert.deepEqual(outside.actions, []);
});
