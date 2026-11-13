const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

test('leaderboard API releases queue slots when fetch or body reading ignores abort', async () => {
    let calls = 0;
    const client = new DragSimLeaderboardClient({
        timeoutMs: 5,
        fetcher: async () => {
            calls++;
            if (calls === 1) return new Promise(() => {});
            if (calls === 2)
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers(),
                    body: { getReader: () => ({ read: () => new Promise(() => {}) }) },
                };
            return response({
                mode: 'main',
                profile_id: 'main',
                total: 5,
                hidden: false,
                partial: false,
            });
        },
    });
    const failures = await Promise.allSettled([
        client.getNetworth('One', 'main'),
        client.getNetworth('Two', 'main'),
    ]);
    assert.ok(
        failures.every(
            (result) => result.status === 'rejected' && /timed out/.test(result.reason.message)
        )
    );
    assert.equal((await client.getNetworth('Three', 'main')).total, 5);
    assert.equal(calls, 3);
});

test('stalled dataset refresh returns a response, resets, and cannot overwrite a later successful refresh', async () => {
    const service = new LeaderboardService({
        sendMinecraftCommand: () => {},
        isMinecraftReady: () => true,
        responseTimeoutMs: 5,
        refreshTimeoutMs: 20,
    });
    const roster = { members: ['One'], observedAt: Date.now() };
    let release;
    const blocked = new Promise((resolve) => {
        release = resolve;
    });
    service.collectDataset = () => blocked;
    service.persistDataset = async () => {};
    try {
        const result = await service.ensureDataset(roster, true);
        assert.match(result, /still refreshing/);
        const pending = service.refreshPromise;
        assert.ok(pending);
        await assert.rejects(pending, /refresh timed out/);
        assert.equal(service.refreshPromise, undefined);
        const fresh = { completedAt: Date.now(), includesNetworth: true, records: [] };
        service.collectDataset = async () => fresh;
        assert.equal(await service.ensureDataset(roster, true), fresh);
        release({ completedAt: 1, includesNetworth: true, records: [] });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(service.dataset, fresh);
    } finally {
        service.stop();
    }
});

test('profile and networth timeouts clear in-progress caches and permit a fresh retry', async () => {
    let blocked = true;
    const service = new LeaderboardService({
        sendMinecraftCommand: () => {},
        isMinecraftReady: () => true,
        lookupTimeoutMs: 5,
        lookup: {
            getProfile: async (username) =>
                blocked ? new Promise(() => {}) : profile({ username }),
            getNetworth: async (username, profileId) =>
                blocked
                    ? new Promise(() => {})
                    : { username, profileId, total: 3, hidden: false, partial: false },
        },
    });
    try {
        await Promise.all([
            assert.rejects(service.getProfile('One'), /timed out/),
            assert.rejects(service.getNetworth('One', 'main'), /timed out/),
        ]);
        assert.equal(service.profileInflight.size, 0);
        assert.equal(service.networthInflight.size, 0);
        blocked = false;
        assert.equal((await service.getProfile('One')).username, 'One');
        assert.equal((await service.getNetworth('One', 'main')).total, 3);
    } finally {
        service.stop();
    }
});

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

test('guild roster includes custom RICH rank after a fully counted Staff group', async () => {
    const collector = new GuildRosterCollector({
        isMinecraftReady: () => true,
        sendCommand: () => {},
    });
    const pending = collector.getRoster();
    collector.handleMessage(
        [
            'Guild Name: Example (3/10 online)',
            'Guild Master [1]',
            'MasterName',
            'Admin [1]',
            'AdminName',
            'Bridge [1]',
            'BridgeName',
            'Staff [4]',
            'StaffOne ● StaffTwo ● StaffThree ● StaffFour',
            '§6RICH [1]',
            '[DRAGON] RichMember',
            'Member [2]',
            'MemberOne ● MemberTwo',
        ].join('\n')
    );
    const roster = await pending;
    assert.deepEqual(roster.members, [
        'MasterName',
        'AdminName',
        'BridgeName',
        'StaffOne',
        'StaffTwo',
        'StaffThree',
        'StaffFour',
        'RichMember',
        'MemberOne',
        'MemberTwo',
    ]);
    assert.equal(roster.guildMaster, 'MasterName');
});

test('guild total prevents early completion when custom ranks follow Member', async () => {
    const collector = new GuildRosterCollector({
        isMinecraftReady: () => true,
        sendCommand: () => {},
    });
    const pending = collector.getRoster();
    collector.handleMessage('Guild Name: Example (1/3 online)');
    collector.handleMessage(
        'Guild Master [1]\nMasterName\nAdmin [0]\nStaff [0]\nBridge [0]\nMember [1]\nMemberName'
    );
    assert.equal(collector.inFlight, true);
    collector.handleMessage('Guild > [MOD] Player: RICH [1]');
    collector.handleMessage('[VIP] Player: Veteran [1] • FakeMember');
    assert.equal(collector.inFlight, true);
    collector.handleMessage('Veteran Elite [1] [VIP+] VeteranName');
    assert.deepEqual((await pending).members, ['MasterName', 'MemberName', 'VeteranName']);
});

test('counted guild roster supports renamed and empty ranks without a hardcoded rank set', async () => {
    const collector = new GuildRosterCollector({
        isMinecraftReady: () => true,
        sendCommand: () => {},
    });
    const pending = collector.getRoster();
    collector.handleMessage(
        'Guild Name: Example (1/3 online)\nGuild Master [1]\nMasterName\nOfficers [0]\nVeterans [2]\nVeteranOne ● VeteranTwo'
    );
    assert.deepEqual((await pending).members, ['MasterName', 'VeteranOne', 'VeteranTwo']);
});

test('custom guild ranks still reject overflow, duplicate players and duplicate groups', async () => {
    for (const [line, error] of [
        ['RICH [2]', /rank counts exceeded/],
        ['RICH [1]\nExtraOne ● ExtraTwo', /exceeded its declared count/],
        ['RICH [1]\nMasterName', /duplicate username/],
        ['RICH [1]\nRICH [1]', /repeated the RICH group/],
    ]) {
        const collector = new GuildRosterCollector({
            isMinecraftReady: () => true,
            sendCommand: () => {},
        });
        const pending = collector.getRoster();
        collector.handleMessage('Guild Name: Example (1/2 online)\nGuild Master [1]\nMasterName');
        collector.handleMessage(line);
        await assert.rejects(pending, error);
    }
});

test('guild roster never publishes an incomplete custom rank or mismatched overall total', async () => {
    for (const line of ['RICH [2]\nRichMember', 'Member [0]']) {
        const collector = new GuildRosterCollector({
            isMinecraftReady: () => true,
            sendCommand: () => {},
            timeoutMs: 10,
        });
        const pending = collector.getRoster();
        collector.handleMessage(
            'Guild Name: Example (1/3 online)\nGuild Master [1]\nMasterName\nAdmin [0]\nStaff [0]\nBridge [0]'
        );
        collector.handleMessage(line);
        await assert.rejects(pending, /Timed out waiting for the complete/);
    }
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

test('leaderboard replaces the thinking response when player data stalls', async () => {
    const service = new LeaderboardService({
        sendMinecraftCommand: () => {},
        isMinecraftReady: () => true,
        responseTimeoutMs: 5,
    });
    service.roster.getRoster = async () => ({ members: ['One'], observedAt: Date.now() });
    service.startDatasetRefresh = () => new Promise(() => {});
    const command = makeCommandInteraction('networth');
    try {
        await service.handleCommand(command.interaction);
        assert.deepEqual(
            command.calls.map(([method]) => method),
            ['deferReply', 'editReply']
        );
        assert.match(command.calls[1][1].content, /still refreshing/);
        assert.deepEqual(command.calls[1][1].components, []);
        assert.equal(service.sessions.size, 0);
    } finally {
        service.stop();
    }
});

function makePlayerInteraction(username, userId = 'player-user') {
    const result = makeCommandInteraction('player', userId);
    result.interaction.options.getString = (name) => (name === 'username' ? username : null);
    return result;
}

function richProfile(username, coins = 1) {
    return profile({
        username,
        uuid: `uuid-${username}`,
        profileId: `profile-${username}`,
        rank: username === 'Master' ? 'MVP_PLUS' : 'DEFAULT',
        profile: {
            coins,
            motes: 20,
            bits: 5,
            skills: { combat: 50, mining: 25 },
            collections: { obsidian: 10, diamond: 5 },
            bestiary: { zombie: { kills: 7 } },
            slayer: { zombie_xp: 100, zombie_level: 3 },
            dungeons: { completions: { F7: 4 }, secrets: 9 },
            hotd: { exp: 200, nodes: { mining_speed: 4 } },
            rng_meters: { dragon: { kills: 6 } },
            stats: { base: { health: 1_000 }, additive: { strength: 50 } },
        },
    });
}

test('leaderboard service ranks only the current roster, paginates 25 rows, and isolates buttons', async () => {
    const names = ['Master', ...Array.from({ length: 26 }, (_, index) => `Member${index + 1}`)];
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
    const searchTime = payload.embeds[0].data.footer.text.match(
        /Time Taken to Search: (\d+\.\d{2})s/
    );
    assert.ok(searchTime, 'the initial embed includes elapsed search time');
    assert.equal((payload.embeds[0].data.description.match(/^\*\*\d+\./gm) || []).length, 25);
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
    assert.ok(
        buttonCalls[1][1].embeds[0].data.footer.text.endsWith(searchTime[0]),
        'paging preserves the original search duration'
    );

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

test('player report uses shared tie ranking, API rank, 25-entry pages, and rejects nonmembers before API work', async () => {
    const names = ['Master', ...Array.from({ length: 26 }, (_, index) => `Member${index + 1}`)];
    let service;
    let profileCalls = 0;
    const lookup = {
        async getProfile(username) {
            profileCalls += 1;
            return richProfile(username, 100);
        },
        async getNetworth(username, profileId) {
            return { username, profileId, total: 100, hidden: false, partial: false };
        },
    };
    service = new LeaderboardService({
        isMinecraftReady: () => true,
        sendMinecraftCommand: () =>
            rosterMessages(names).forEach((line) => service.handleMinecraftMessage(line)),
        lookup,
        now: () => 1_000,
        cooldownMs: 0,
    });
    const command = makePlayerInteraction('Member1');
    await service.handleCommand(command.interaction);
    const initial = command.calls.find(([name]) => name === 'editReply')[1];
    assert.equal(profileCalls, names.length);
    assert.match(initial.embeds[0].data.description, /Player: \*\*Member1\*\*/);
    assert.match(initial.embeds[0].data.description, /^\*\*#2\*\* · /m);
    assert.doesNotMatch(initial.embeds[0].data.description, /\[MVP\+\] Member1/);
    assert.match(initial.embeds[0].data.footer.text, /Report page 1\/2/);
    assert.equal(
        (initial.embeds[0].data.description.match(/^\*\*(?:#\d+|Unranked)\*\* · /gm) || []).length,
        25
    );
    const nextId = initial.components[0].components[2].data.custom_id;
    const buttonCalls = [];
    await service.handleInteraction({
        customId: nextId,
        guildId: '12345678901234567',
        channelId: '12345678901234568',
        message: {
            id: 'leaderboard-message',
            guildId: '12345678901234567',
            embeds: [initial.embeds[0].toJSON()],
        },
        async deferUpdate() {},
        async editReply(payload) {
            buttonCalls.push(payload);
        },
        async followUp(payload) {
            buttonCalls.push(payload);
        },
    });
    assert.match(buttonCalls[0].embeds[0].data.footer.text, /Report page 2\/2/);
    assert.equal(profileCalls, names.length, 'paging reuses one shared dataset');

    const nonmember = makePlayerInteraction('NotInGuild', 'other-player');
    await service.handleCommand(nonmember.interaction);
    assert.match(nonmember.calls.at(-1)[1].content, /not a current member/);
    assert.equal(profileCalls, names.length, 'nonmembers are rejected before API work');
    service.stop();
});

test('player reports sort best positions first, unavailable last and capitalise categories', () => {
    const service = new LeaderboardService({
        isMinecraftReady: () => true,
        sendMinecraftCommand() {},
    });
    const dataset = {
        completedAt: Date.now(),
        metrics: ['networth', 'purse', 'collections', 'rng'].map((category) => ({
            id: category,
            category,
            label: category,
            unit: 'amount',
            default: true,
        })),
        records: [
            {
                username: 'Player',
                profileId: 'one',
                values: { networth: 50, purse: 100, rng: 20 },
                approximate: {},
            },
            {
                username: 'Other',
                profileId: 'two',
                values: { networth: 100, purse: 50, rng: 10 },
                approximate: {},
            },
        ],
    };
    const report = service.buildPlayerReport(
        dataset,
        { members: ['Player', 'Other'], observedAt: Date.now() },
        'Player',
        12
    );
    assert.deepEqual(
        report.entries.map((entry) => entry.metric.id),
        ['purse', 'rng', 'networth', 'collections']
    );
    assert.deepEqual(
        report.entries.map((entry) => entry.position),
        [1, 1, 2, undefined]
    );
    const payload = service.reportPayload({ id: 'test', report }, 0);
    const description = payload.embeds[0].data.description;
    assert.match(description, /^\*\*#1\*\* · Purse/m);
    assert.match(description, /^\*\*#1\*\* · RNG/m);
    assert.match(description, /^\*\*#2\*\* · Networth/m);
    assert.match(description, /^\*\*Unranked\*\* · Collections .*Unavailable/m);
    assert.doesNotMatch(description, /^\*\*\d+\./m);
    service.stop();
});

test('stale cached leaderboards render immediately while refresh runs, and over-stale data fails closed', async () => {
    let now = 1_000;
    let service;
    let release;
    let blockProfiles = false;
    const lookup = {
        async getProfile(username) {
            if (blockProfiles)
                return new Promise((resolve) => {
                    release = () => resolve(richProfile(username));
                });
            return richProfile(username);
        },
        async getNetworth(username, profileId) {
            return { username, profileId, total: 100, hidden: false, partial: false };
        },
    };
    service = new LeaderboardService({
        isMinecraftReady: () => true,
        sendMinecraftCommand: () =>
            rosterMessages(['Master']).forEach((line) => service.handleMinecraftMessage(line)),
        lookup,
        now: () => now,
        cooldownMs: 0,
    });
    await service.handleCommand(makeCommandInteraction('purse').interaction);
    now += 301_001;
    blockProfiles = true;
    const cached = makeCommandInteraction('purse', 'cached-user');
    await service.handleCommand(cached.interaction);
    const cachedPayload = cached.calls.at(-1)[1];
    assert.match(cachedPayload.embeds[0].data.description, /Stats updated:/);
    assert.match(cachedPayload.embeds[0].data.description, /background refresh ongoing/);
    release();
    service.stop();

    let expiredNow = 1_000;
    let expiredService;
    let expireProfiles = false;
    expiredService = new LeaderboardService({
        isMinecraftReady: () => true,
        sendMinecraftCommand: () =>
            rosterMessages(['Master']).forEach((line) =>
                expiredService.handleMinecraftMessage(line)
            ),
        now: () => expiredNow,
        cooldownMs: 0,
        lookup: {
            async getProfile(username) {
                if (expireProfiles) throw new Error('blocked');
                return richProfile(username);
            },
            async getNetworth(username, profileId) {
                if (expireProfiles) throw new Error('blocked');
                return { username, profileId, total: 100, hidden: false, partial: false };
            },
        },
    });
    const expired = makeCommandInteraction('purse');
    await expiredService.handleCommand(expired.interaction);
    expiredNow += 16 * 60_000;
    expireProfiles = true;
    const refused = makeCommandInteraction('purse', 'expired-user');
    await expiredService.handleCommand(refused.interaction);
    assert.match(refused.calls.at(-1)[1].content, /Player stats are not available yet/);
    expiredService.stop();
});

test('leaderboard cache round-trips sanitized numeric data with private file permissions', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-bridge-leaderboard-'));
    let service;
    const names = ['Master'];
    const lookup = {
        async getProfile(username) {
            return richProfile(username, 100);
        },
        async getNetworth(username, profileId) {
            return { username, profileId, total: 100, hidden: false, partial: false };
        },
    };
    const options = {
        isMinecraftReady: () => true,
        sendMinecraftCommand: () =>
            rosterMessages(names).forEach((line) => service.handleMinecraftMessage(line)),
        lookup,
        now: () => 1_000,
        cooldownMs: 0,
        dataDir,
    };
    service = new LeaderboardService(options);
    await service.handleCommand(makeCommandInteraction('networth').interaction);
    service.stop();
    const cachePath = path.join(dataDir, 'leaderboard-cache.json');
    assert.equal(fs.statSync(cachePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
    const cacheText = fs.readFileSync(cachePath, 'utf8');
    assert.doesNotMatch(cacheText, /inventory|profile\":\{/);

    let apiCalls = 0;
    let restored;
    restored = new LeaderboardService({
        isMinecraftReady: () => true,
        sendMinecraftCommand: () =>
            rosterMessages(names).forEach((line) => restored.handleMinecraftMessage(line)),
        lookup: {
            async getProfile() {
                apiCalls += 1;
                throw new Error('cache should be used');
            },
            async getNetworth() {
                apiCalls += 1;
                throw new Error('cache should be used');
            },
        },
        now: () => 1_001,
        cooldownMs: 0,
        dataDir,
    });
    const fromCache = makeCommandInteraction('networth', 'restored-user');
    await restored.handleCommand(fromCache.interaction);
    assert.equal(apiCalls, 0);
    assert.match(fromCache.calls.at(-1)[1].embeds[0].data.description, /Master/);
    let choices;
    await restored.handleAutocomplete({
        commandName: 'gleaderboard',
        options: { getSubcommand: () => 'collections', getString: () => 'obsidian' },
        async respond(value) {
            choices = value;
        },
    });
    assert.ok(
        choices.some((choice) => choice.value.endsWith('.obsidian')),
        'persisted dynamic metrics survive restart'
    );
    assert.equal(apiCalls, 0);
    restored.stop();

    const valid = JSON.parse(cacheText);
    for (const invalid of [
        '{bad json',
        JSON.stringify({ ...valid, schemaVersion: 99 }),
        JSON.stringify({ ...valid, context: { ...valid.context, serverId: 'other' } }),
        JSON.stringify({ ...valid, completedAt: -1_000_000 }),
        JSON.stringify({ ...valid, completedAt: 1_000_000 }),
    ]) {
        fs.writeFileSync(cachePath, invalid);
        const rejected = new LeaderboardService(options);
        assert.equal(rejected.dataset, undefined, 'invalid or wrongly scoped cache is ignored');
        rejected.stop();
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('player report pages recalculate departed members and retain the original search time', async () => {
    let names = ['Master', 'Member1'];
    let service;
    service = new LeaderboardService({
        isMinecraftReady: () => true,
        sendMinecraftCommand: () =>
            rosterMessages(names).forEach((line) => service.handleMinecraftMessage(line)),
        cooldownMs: 0,
        lookup: {
            async getProfile(username) {
                return richProfile(username, 100);
            },
            async getNetworth(username, profileId) {
                return { username, profileId, total: 100, hidden: false };
            },
        },
    });
    const command = makePlayerInteraction('Member1');
    await service.handleCommand(command.interaction);
    let payload = command.calls.at(-1)[1];
    const footerTime = payload.embeds[0].data.footer.text.split(' • ')[1];
    async function page(direction) {
        await service.handleInteraction({
            customId: payload.components[0].components[direction === 'next' ? 2 : 0].data.custom_id,
            guildId: '12345678901234567',
            channelId: '12345678901234568',
            message: {
                id: 'leaderboard-message',
                guildId: '12345678901234567',
                embeds: [payload.embeds[0].toJSON()],
            },
            async deferUpdate() {},
            async editReply(value) {
                payload = value;
            },
            async followUp(value) {
                throw new Error(value.content);
            },
        });
    }
    await page('next');
    assert.match(payload.embeds[0].data.footer.text, /Report page 2\/2/);
    names = ['Member1'];
    service.roster.disconnected();
    await page('prev');
    assert.match(payload.embeds[0].data.description, /^\*\*#1\*\* · /m);
    assert.equal(payload.embeds[0].data.footer.text.split(' • ')[1], footerTime);
    names = ['Master'];
    service.roster.disconnected();
    await page('next');
    assert.match(payload.content, /no longer a current guild member/);
    assert.deepEqual(payload.components, []);
    service.stop();
});

test('simultaneous cold lookups share one refresh and shutdown prevents publishing late data', async () => {
    let release;
    let calls = 0;
    const service = new LeaderboardService({
        isMinecraftReady: () => true,
        sendMinecraftCommand() {},
        lookup: {
            getProfile(username) {
                calls++;
                return new Promise((resolve) => {
                    release = () => resolve(richProfile(username));
                });
            },
            async getNetworth(username, profileId) {
                return { username, profileId, total: 1, hidden: false };
            },
        },
    });
    const roster = { members: ['Master'], observedAt: Date.now() };
    const first = service.startDatasetRefresh(roster, true);
    const second = service.startDatasetRefresh(roster, true);
    assert.equal(first, second);
    assert.equal(calls, 1);
    service.stop();
    release();
    await assert.rejects(first, /connection changed/);
    assert.equal(service.dataset, undefined);
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
    assert.deepEqual(extractGuildListUsernames('First ● [DRAGON] Second ● Third'), [
        'First',
        'Second',
        'Third',
    ]);
    assert.deepEqual(extractGuildListUsernames('[VIP] Other: hello • FakeMember'), []);
    assert.deepEqual(extractGuildListUsernames('[VIP] Name extra • FakeMember'), []);
    assert.deepEqual(extractGuildListUsernames('[MVP+] IronMember ♲ ● Other'), [
        'IronMember',
        'Other',
    ]);
    assert.deepEqual(extractGuildListUsernames('IronMember ♲ extra ● Other'), []);
    assert.deepEqual(extractGuildListUsernames('Guild > IronMember: hello ♲ ● Other'), []);
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
                    service.roster.disconnected();
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
    service.roster.disconnected();
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

test('guild roster is reused for ten minutes and supports forced background refresh', async () => {
    let now = 1_000;
    let requests = 0;
    const collector = new GuildRosterCollector({
        now: () => now,
        isMinecraftReady: () => true,
        sendCommand: () => {
            requests++;
            completeRoster(collector);
        },
    });
    await collector.getRoster();
    now += 599_000;
    await collector.getRoster();
    assert.equal(requests, 1);
    now += 1_000;
    await collector.getRoster();
    assert.equal(requests, 2);
    await collector.getRoster(true);
    assert.equal(requests, 3);
    collector.disconnected();
    await collector.getRoster();
    assert.equal(requests, 4);
});

test('public refresh forces the roster and both API caches, and rejects concurrent refreshes', async () => {
    let profileCalls = 0,
        networthCalls = 0,
        rosterCalls = 0;
    const service = new LeaderboardService({
        isMinecraftReady: () => true,
        now: () => 1_000,
        cooldownMs: 0,
        sendMinecraftCommand: () => {
            rosterCalls++;
            rosterMessages(['Master']).forEach((line) => service.handleMinecraftMessage(line));
        },
        lookup: {
            async getProfile(username) {
                profileCalls++;
                return profile({ username });
            },
            async getNetworth(username, profileId) {
                networthCalls++;
                return { username, profileId, total: 500, hidden: false, partial: true };
            },
        },
    });
    await service.handleCommand(makeCommandInteraction('networth').interaction);
    const refresh = makeCommandInteraction('refresh');
    const pending = service.handleRefresh(refresh.interaction);
    const duplicate = makeCommandInteraction('refresh', 'other-user');
    await service.handleRefresh(duplicate.interaction);
    assert.match(duplicate.calls[0][1].content, /already running/);
    await pending;
    assert.equal(profileCalls, 2);
    assert.equal(networthCalls, 2);
    assert.equal(rosterCalls, 2);
    assert.match(refresh.calls.at(-1)[1].content, /Fresh player stats: 1\/1/);
    const cooled = makeCommandInteraction('refresh');
    await service.handleRefresh(cooled.interaction);
    assert.match(cooled.calls[0][1].content, /wait a minute/);
    await service.handleCommand(makeCommandInteraction('networth').interaction);
    assert.equal(profileCalls, 2);
    assert.equal(networthCalls, 2);
});
