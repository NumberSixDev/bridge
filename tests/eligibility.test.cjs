const { test } = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
    MINECRAFT_EMAIL: 'bridge@example.test',
    DISCORD_TOKEN: 'test-token',
    DISCORD_SERVER_ID: '12345678901234567',
    MEMBER_CHANNEL_ID: '12345678901234568',
    STAFF_COMMAND_CHANNEL_ID: '12345678901234569',
    BOT_OWNER_ID: '12345678901234570',
    STAFF_ROLE_ID: '12345678901234571',
});

const eligibilityEmbed = require('../dist/src/recruitment/eligibility').default;
const RecruitmentService = require('../dist/src/recruitment/service').default;
const MemoryStore = require('../dist/src/recruitment/memory-store').default;
const command = require('../dist/src/discord/commands/eligibility').default;
const router = require('../dist/src/discord/events/interaction-create').default;
const NOW = 1_000_000_000_000;
const minima = { autoAcceptEnabled: false, minimumNetworth: 500, minimumPurse: 100 };

function evidence(overrides = {}) {
    return {
        username: 'Applicant',
        playerUuid: 'uuid',
        profileId: 'profile',
        profileName: '§7Wise',
        profileSavedAt: NOW,
        calculatedAt: NOW,
        marketObservedAt: NOW,
        purse: 100,
        networth: 500,
        partial: false,
        hidden: false,
        unpriced: 0,
        uncertainValue: 0,
        identityVerified: true,
        coverageIssues: [],
        ...overrides,
    };
}

test('eligibility requires both minimums, treats equality as passing and ignores the auto-accept switch', () => {
    for (const [values, eligible, networthTick, purseTick] of [
        [{}, true, '✅', '✅'],
        [{ networth: 499 }, false, '❌', '✅'],
        [{ purse: 99 }, false, '✅', '❌'],
        [{ networth: 499, purse: 99 }, false, '❌', '❌'],
    ]) {
        const embed = eligibilityEmbed(evidence(values), minima, NOW, 1250).toJSON();
        assert.ok(
            embed.description.includes(eligible ? '✅ Eligible to join' : '❌ Not eligible to join')
        );
        assert.ok(embed.description.includes(`${networthTick} Networth`));
        assert.ok(embed.description.includes(`${purseTick} Purse`));
        assert.match(embed.description, /Profile: \*\*Wise\*\* \(main\)/);
        assert.doesNotMatch(embed.description, /§7/);
        assert.match(embed.description, /Profile saved: <t:1000000000:R>/);
        assert.equal(embed.footer.text, 'Time Taken to Search: 1.25s');
    }
});

test('incomplete, stale, private, missing and mismatched evidence never yields a definitive eligible verdict', () => {
    for (const overrides of [
        { partial: true },
        { hidden: true },
        { unpriced: 1 },
        { profileSavedAt: NOW - 300_001 },
        { purse: undefined },
        { networth: undefined },
        { identityVerified: false },
    ]) {
        const embed = eligibilityEmbed(evidence(overrides), minima, NOW, 0).toJSON();
        assert.match(embed.description, /Manual review required/);
        assert.match(embed.description, /Data check:/);
        assert.doesNotMatch(embed.description, /✅ Eligible to join/);
    }
    const unset = eligibilityEmbed(evidence(), { autoAcceptEnabled: false }, NOW, 0).toJSON();
    assert.match(unset.description, /Set both guild minimums first/);
    assert.match(unset.description, /Minimum not set/);
});

function harness({
    roles = ['1569762077592125510'],
    channelId,
    username = 'Applicant',
    fail = false,
} = {}) {
    const state = { lookups: [], guildCommands: [], replies: [], roleFetches: 0 };
    const store = new MemoryStore({
        version: 1,
        settings: { ...minima, autoAcceptEnabled: true },
        applications: [],
    });
    const interaction = {
        commandName: 'eligibility',
        guildId: process.env.DISCORD_SERVER_ID,
        channelId: channelId ?? process.env.STAFF_COMMAND_CHANNEL_ID,
        user: { id: process.env.BOT_OWNER_ID },
        member: { roles: { cache: new Map([[process.env.STAFF_ROLE_ID, {}]]) } },
        guild: {
            members: {
                fetch: async () => {
                    state.roleFetches++;
                    return { roles: { cache: new Map(roles.map((role) => [role, {}])) } };
                },
            },
        },
        options: { data: [], getString: () => username },
        inCachedGuild: () => true,
        isChatInputCommand: () => true,
        async reply(payload) {
            state.replies.push(payload);
        },
        async deferReply() {
            this.deferred = true;
        },
        async editReply(payload) {
            state.replies.push(payload);
        },
    };
    const service = new RecruitmentService({
        store,
        now: () => NOW,
        lookup: {
            lookup: async (name) => {
                assert.equal(interaction.deferred, true);
                state.lookups.push(name);
                if (fail) throw new Error('Expected API failure');
                return evidence({ username: name });
            },
        },
        getChannel: () => undefined,
        isMinecraftReady: () => true,
        sendAcceptance: (name) => state.guildCommands.push(name),
    });
    const bridge = {
        recruitment: service,
        discord: { commands: new Map([['eligibility', command]]) },
    };
    return { state, store, service, interaction, run: () => router.run(bridge, interaction) };
}

test('both configured roles can check an arbitrary player without creating applications or sending guild commands', async () => {
    for (const role of ['1569762077592125510', '1569548424884387850']) {
        const h = harness({ roles: [role], username: 'OutsideGuild' });
        const before = h.store.snapshot();
        try {
            await h.run();
            assert.deepEqual(h.state.lookups, ['OutsideGuild']);
            assert.equal(h.state.roleFetches, 1);
            assert.match(h.state.replies[0].embeds[0].data.title, /OutsideGuild/);
            assert.match(h.state.replies[0].embeds[0].data.description, /Eligible to join/);
            assert.deepEqual(h.state.replies[0].allowedMentions, { parse: [] });
            assert.deepEqual(h.store.snapshot(), before);
            assert.deepEqual(h.state.guildCommands, []);
        } finally {
            h.service.stop();
        }
    }
});

test('eligibility denies wrong channels and roles, including owner/staff bypass attempts', async () => {
    for (const options of [{ channelId: process.env.MEMBER_CHANNEL_ID }, { roles: [] }]) {
        const h = harness(options);
        try {
            await h.run();
            assert.deepEqual(h.state.lookups, []);
            assert.equal(h.state.replies[0].ephemeral, true);
            assert.equal(h.state.roleFetches, options.channelId ? 0 : 1);
        } finally {
            h.service.stop();
        }
    }
});

test('invalid usernames and API failures return helpful replies without an eligibility verdict or side effects', async () => {
    for (const options of [{ username: '../invalid' }, { fail: true }]) {
        const h = harness(options);
        try {
            await h.run();
            const reply = h.state.replies[0];
            assert.match(
                reply.content,
                options.fail ? /could not be verified/ : /Minecraft username/
            );
            assert.equal(reply.embeds, undefined);
            assert.deepEqual(h.store.snapshot().applications, []);
            assert.deepEqual(h.state.guildCommands, []);
            assert.equal(h.state.lookups.length, options.fail ? 1 : 0);
        } finally {
            h.service.stop();
        }
    }
});
