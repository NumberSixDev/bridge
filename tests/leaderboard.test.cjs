const { test } = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
    MINECRAFT_EMAIL: 'bridge@example.test',
    DISCORD_TOKEN: 'test-token',
    DISCORD_SERVER_ID: '12345678901234567',
    MEMBER_CHANNEL_ID: '12345678901234568',
    BOT_OWNER_ID: '',
    STAFF_ROLE_ID: '',
    USE_PROFANITY_FILTER: 'false',
});

const {
    GuildRosterCollector,
    extractGuildListUsernames,
} = require('../dist/src/leaderboard/roster.js');
const { DragSimLeaderboardClient } = require('../dist/src/leaderboard/api.js');
const { metricDefinitions, findMetricDefinition } = require('../dist/src/leaderboard/metrics.js');
const LeaderboardService = require('../dist/src/leaderboard/service.js').default;

function completeRoster(collector, names = ['Master', 'AdminOne', 'MemberOne']) {
    collector.handleMessage('Guild > [VIP] ChatSpoof: ignored');
    collector.handleMessage('§6Guild Master [1]');
    collector.handleMessage(`§a[VIP] ${names[0]}`);
    collector.handleMessage(`Admin [${names.length > 2 ? 1 : 0}]`);
    if (names.length > 2) collector.handleMessage(`• §b[MVP+] ${names[1]}`);
    collector.handleMessage('Staff [0]');
    collector.handleMessage('Bridge [0]');
    collector.handleMessage(`Member [${names.length > 2 ? 1 : 0}]`);
    if (names.length > 2) collector.handleMessage(`• ${names[2]}`);
}

test('guild roster accepts coloured prefixes, multiline output, zero groups and ignores chat spoofing', async () => {
    let commandCount = 0;
    const collector = new GuildRosterCollector({
        isMinecraftReady: () => true,
        sendCommand: (command) => {
            commandCount += 1;
            assert.equal(command, '/g list');
        },
        now: () => 1_000,
    });
    const pending = collector.getRoster();
    collector.handleMessage('Admin [4] • ShouldBeIgnored');
    collector.handleMessage('Guild > [DRAGON] Spoof: hello');
    collector.handleMessage('§6Guild Master [1]\n§a[MVP+] MasterName');
    collector.handleMessage('Admin [2]\n• §b[VIP] AdminOne • §7AdminTwo');
    collector.handleMessage('Staff [0]');
    collector.handleMessage('Bridge [0]');
    collector.handleMessage('Member [1]');
    collector.handleMessage('§fMemberOne');
    const roster = await pending;
    assert.equal(commandCount, 1);
    assert.deepEqual(roster.members, ['MasterName', 'AdminOne', 'AdminTwo', 'MemberOne']);
    assert.deepEqual(extractGuildListUsernames('Guild > [VIP] Player: hello'), []);
});

test('guild roster is single-flight and caches only complete responses', async () => {
    let commandCount = 0;
    const collector = new GuildRosterCollector({
        isMinecraftReady: () => true,
        sendCommand: () => {
            commandCount += 1;
        },
        now: () => 1_000,
        timeoutMs: 20,
    });
    const first = collector.getRoster();
    const second = collector.getRoster();
    completeRoster(collector);
    const [one, two] = await Promise.all([first, second]);
    assert.deepEqual(one.members, two.members);
    assert.equal(commandCount, 1);
    assert.deepEqual((await collector.getRoster()).members, one.members);
    assert.equal(commandCount, 1);
});

test('guild roster rejects mismatches, incomplete responses, and disconnects without stale fallback', async () => {
    const collector = new GuildRosterCollector({
        isMinecraftReady: () => true,
        sendCommand: () => {},
        timeoutMs: 10,
    });
    const mismatch = collector.getRoster();
    collector.handleMessage('Guild Master [1]');
    collector.handleMessage('Master');
    collector.handleMessage('Admin [0]');
    collector.handleMessage('Extra');
    await assert.rejects(mismatch, /duplicate|exceeded|complete/);

    const incomplete = collector.getRoster();
    collector.handleMessage('Guild Master [1]');
    collector.disconnected();
    await assert.rejects(incomplete, /disconnected/);
    await assert.rejects(collector.getRoster(), /timed out|disconnected|not connected/i);
});

function profile(overrides = {}) {
    return {
        username: 'Player',
        uuid: 'uuid',
        profileId: 'profile',
        observedAt: 1_000,
        inventoryHidden: false,
        profile: {
            coins: 100,
            motes: 20,
            skills: { combat: 50, mining: 25 },
            collections: { obsidian: 10, ender_stone: 5 },
            bestiary: { zombie: { kills: 7 } },
            slayer: { zombie_xp: 100, zombie_level: 3 },
            dungeons: { completions: { F7: 4 }, secrets: 9 },
            hotd: { exp: 200, nodes: { mining_speed: 4 } },
            rng_meters: { dragon: { kills: 6 } },
            stats: { base: { health: 1_000 }, additive: { strength: 50 } },
        },
        ...overrides,
    };
}

test('metric catalogue only extracts allowed numeric leaves and treats sparse valid maps as zero', () => {
    const player = profile();
    const collections = metricDefinitions('collections', [player]);
    assert.equal(
        findMetricDefinition('collections', 'collections.obsidian', [player]).extract(player),
        10
    );
    assert.equal(
        findMetricDefinition('collections', 'collections.rough_amethyst', [player]).extract(player),
        0
    );
    assert.equal(
        findMetricDefinition('collections', 'collections.total', [player]).extract(player),
        15
    );
    assert.equal(findMetricDefinition('skills', 'skills.total', [player]).extract(player), 75);
    assert.equal(findMetricDefinition('bestiary', 'bestiary.total', [player]).extract(player), 7);
    assert.equal(
        findMetricDefinition('dungeons', 'dungeons.completions.F7', [player]).extract(player),
        4
    );
    assert.equal(findMetricDefinition('rng', 'rng.dragon.kills', [player]).extract(player), 6);
    assert.ok(collections.some((metric) => metric.id === 'collections.obsidian'));

    const invalid = profile({ profile: { collections: { obsidian: '10' } } });
    assert.equal(
        findMetricDefinition('collections', 'collections.obsidian', [invalid]).extract(invalid),
        undefined
    );
    const missing = profile({ profile: {} });
    assert.equal(
        findMetricDefinition('collections', 'collections.obsidian', [missing]).extract(missing),
        undefined
    );
});

function response(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

test('leaderboard API validates profile identity, selected NORMAL profile, networth identity and one bounded 429 retry', async () => {
    const calls = [];
    let retry = true;
    const client = new DragSimLeaderboardClient({
        baseUrl: 'https://dragsim.co/api/',
        sleep: async () => {},
        fetcher: async (url) => {
            calls.push(String(url));
            if (String(url).includes('/networth/') && retry) {
                retry = false;
                return response({}, 429, { 'retry-after': '0' });
            }
            if (String(url).includes('/player/')) {
                return response({
                    mode: 'main',
                    fetched_at: 1_000,
                    player: { player: 'Player', uuid: 'uuid', rank: 'MVP_PLUS' },
                    profiles: [{ id: 'profile', selected: true }],
                    profile: {
                        id: 'profile',
                        profile_name: 'Main',
                        profile_mode: 'NORMAL',
                        inventory_hidden: true,
                        coins: 50,
                    },
                });
            }
            return response({
                mode: 'main',
                profile_id: 'profile',
                total: 500,
                hidden: false,
                partial: true,
                calculated_at: 1_001,
            });
        },
    });
    const player = await client.getProfile('Player');
    assert.equal(player.inventoryHidden, true);
    assert.equal(player.profileId, 'profile');
    assert.equal(player.rank, 'MVP_PLUS');
    const networth = await client.getNetworth('Player', 'profile');
    assert.equal(networth.total, 500);
    assert.equal(networth.partial, true);
    assert.equal(calls.length, 3);
    await assert.rejects(client.getProfile('Other'), /different player/);
});

function rosterMessages(names) {
    return [
        'Guild Master [1]',
        names[0],
        'Admin [0]',
        'Staff [0]',
        'Bridge [0]',
        `Member [${names.length - 1}]`,
        names
            .slice(1)
            .map((name) => `• ${name}`)
            .join(' '),
    ];
}

function makeCommandInteraction(subcommand, userId = 'user') {
    const calls = [];
    const interaction = {
        commandName: 'gleaderboard',
        guildId: '12345678901234567',
        channelId: '12345678901234568',
        user: { id: userId },
        options: {
            getSubcommand: () => subcommand,
            getString: () => null,
        },
        async deferReply() {
            calls.push(['deferReply']);
        },
        async editReply(payload) {
            calls.push(['editReply', payload]);
            return { id: 'leaderboard-message' };
        },
        async fetchReply() {
            return { id: 'leaderboard-message' };
        },
        async reply(payload) {
            calls.push(['reply', payload]);
        },
    };
    return { interaction, calls };
}

test('leaderboard service ranks only the current roster, paginates ten rows, and isolates buttons', async () => {
    const names = ['Master', ...Array.from({ length: 11 }, (_, index) => `Member${index + 1}`)];
    let rosterRequest = 0;
    const lookup = {
        async getProfile(username) {
            return profile({
                username,
                profile: {
                    coins: username === 'Master' ? 1_000 : Number(username.replace('Member', '')),
                },
            });
        },
        async getNetworth() {
            throw new Error('networth must not be requested for purse');
        },
    };
    const service = new LeaderboardService({
        isMinecraftReady: () => true,
        sendMinecraftCommand: () => {
            rosterRequest += 1;
            for (const message of rosterMessages(names)) service.handleMinecraftMessage(message);
        },
        lookup,
        now: () => 1_000,
        cooldownMs: 0,
    });
    const command = makeCommandInteraction('purse');
    await service.handleCommand(command.interaction);
    assert.equal(rosterRequest, 1);
    const payload = command.calls.find(([name]) => name === 'editReply')[1];
    assert.match(payload.embeds[0].data.description, /Master/);
    assert.match(payload.embeds[0].data.footer.text, /Page 1\/2/);
    assert.equal(payload.components[0].components[0].data.disabled, true);
    const nextId = payload.components[0].components[2].data.custom_id;

    const buttonCalls = [];
    const button = {
        customId: nextId,
        guildId: '12345678901234567',
        channelId: '12345678901234568',
        message: {
            id: 'leaderboard-message',
            guildId: '12345678901234567',
            embeds: [payload.embeds[0].toJSON()],
        },
        async deferUpdate() {
            buttonCalls.push(['deferUpdate']);
        },
        async editReply(next) {
            buttonCalls.push(['editReply', next]);
        },
        async followUp(next) {
            buttonCalls.push(['followUp', next]);
        },
    };
    await service.handleInteraction(button);
    assert.equal(buttonCalls[0][0], 'deferUpdate');
    assert.match(buttonCalls[1][1].embeds[0].data.description, /Member1/);
    assert.match(buttonCalls[1][1].embeds[0].data.footer.text, /Page 2\/2/);

    const wrongChannel = {
        ...button,
        channelId: '99999999999999999',
        async deferUpdate() {},
        async followUp(next) {
            buttonCalls.push(['followUp', next]);
        },
    };
    await service.handleInteraction(wrongChannel);
    assert.equal(buttonCalls.at(-1)[1].ephemeral, true);
});

const { playerLabel } = require('../dist/src/leaderboard/presentation.js');

test('leaderboard rank labels preserve plus ranks and do not invent a rank for default players', () => {
    assert.equal(playerLabel('Example', 'MVP_PLUS'), '[MVP+] Example');
    assert.equal(playerLabel('Example', 'VIP_PLUS'), '[VIP+] Example');
    assert.equal(playerLabel('Example', 'DRAGON'), '[DRAGON] Example');
    assert.equal(playerLabel('Example', 'DEFAULT'), 'Example');
    assert.equal(playerLabel('Example', '@everyone'), 'Example');
});

test('roster parser rejects a whole chat-like line containing bullets and handles hex colours', () => {
    assert.deepEqual(extractGuildListUsernames('[VIP] Other: hello • FakeMember'), []);
    assert.deepEqual(extractGuildListUsernames('[VIP] Name extra • FakeMember'), []);
    assert.deepEqual(extractGuildListUsernames('§x§1§2§3§4§5§6[MOD] Member • [VIP+] Other •'), [
        'Member',
        'Other',
    ]);
});

test('private networth and missing currency values are never ranked as public values or zero', () => {
    const metric = findMetricDefinition('networth', undefined, []);
    assert.equal(
        metric.extract(profile({ inventoryHidden: true }), { total: 500, hidden: false }),
        undefined
    );
    assert.equal(metric.extract(profile(), { total: 500, hidden: true }), undefined);
    assert.equal(metric.extract(profile(), { total: 500, hidden: false, partial: true }), 500);
    assert.equal(
        findMetricDefinition('currencies', 'currencies.bits', []).extract(profile({ profile: {} })),
        undefined
    );
});

test('leaderboard removes departed members before publishing and on navigation, and expires buttons', async () => {
    let now = 1_000;
    let names = ['Master', ...Array.from({ length: 11 }, (_, i) => `Member${i + 1}`)];
    let fetches = 0;
    const service = new LeaderboardService({
        now: () => now,
        cooldownMs: 0,
        isMinecraftReady: () => true,
        sendMinecraftCommand: () =>
            rosterMessages(names).forEach((line) => service.handleMinecraftMessage(line)),
        lookup: {
            async getProfile(username) {
                fetches++;
                if (username === 'Master') {
                    now += 61_000;
                    names = names.filter((name) => name !== 'Member11');
                }
                return profile({
                    username,
                    rank: 'MVP_PLUS',
                    profile: { coins: username === 'Master' ? 1000 : 1 },
                });
            },
            async getNetworth() {
                throw new Error('unexpected networth request');
            },
        },
    });
    const command = makeCommandInteraction('purse');
    await service.handleCommand(command.interaction);
    const payload = command.calls.find(([kind]) => kind === 'editReply')[1];
    assert.match(payload.embeds[0].data.description, /Ranked \*\*11\*\* of \*\*11\*\*/);
    assert.match(payload.embeds[0].data.description, /\[MVP\+\] Master/);
    const buttonCalls = [];
    const button = {
        customId: payload.components[0].components[2].data.custom_id,
        guildId: '12345678901234567',
        channelId: '12345678901234568',
        message: {
            id: 'leaderboard-message',
            guildId: '12345678901234567',
            embeds: [payload.embeds[0].toJSON()],
        },
        async deferUpdate() {},
        async editReply(value) {
            buttonCalls.push(['edit', value]);
        },
        async followUp(value) {
            buttonCalls.push(['private', value]);
        },
    };
    names = names.filter((name) => name !== 'Master');
    now += 61_000;
    await service.handleInteraction(button);
    assert.doesNotMatch(buttonCalls[0][1].embeds[0].data.description, /Master|Member11/);
    assert.match(buttonCalls[0][1].embeds[0].data.footer.text, /Page 1\/1/);
    assert.equal(fetches, 12, 'paging must reuse the stable stats snapshot');
    now += 601_000;
    await service.handleInteraction(button);
    assert.equal(buttonCalls.at(-1)[0], 'private');
    assert.match(buttonCalls.at(-1)[1].content, /expired/);
});

test('long API retry-after stops queued requests instead of hammering a rate-limited endpoint', async () => {
    let calls = 0;
    const client = new DragSimLeaderboardClient({
        now: () => 1_000,
        fetcher: async () => {
            calls++;
            return response({}, 429, { 'retry-after': '60' });
        },
    });
    await assert.rejects(client.getProfile('Player'), /rate limited/);
    await assert.rejects(client.getProfile('Other'), /rate limited/);
    assert.equal(calls, 1);
});
