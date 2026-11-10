const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

Object.assign(process.env, {
    MINECRAFT_EMAIL: 'bridge@example.test',
    DISCORD_TOKEN: 'test-token',
    DISCORD_SERVER_ID: '12345678901234567',
    MEMBER_CHANNEL_ID: '12345678901234568',
    STAFF_COMMAND_CHANNEL_ID: '12345678901234568',
    BOT_OWNER_ID: '',
    STAFF_ROLE_ID: '',
    USE_PROFANITY_FILTER: 'false',
    PURGE_ALLOW_PARTIAL_NETWORTH: 'false',
    PURGE_PROTECTED_USERNAMES: '',
});

const runtimeEnv = require('../dist/src/util/env.js').default;
const {
    buildPurgeRows,
    evaluateFreshPurgeEvidence,
    default: PurgeService,
} = require('../dist/src/purge/service.js');
const { parseKickCapabilityHelpLine } = require('../dist/src/purge/capability.js');
const { FilePurgeStore } = require('../dist/src/purge/store.js');
const MemoryPurgeStore = require('../dist/src/purge/memory-store.js').default;

const NOW = 1_000_000_000_000;

function settings(overrides = {}) {
    return {
        autoAcceptEnabled: false,
        minimumNetworth: 100,
        minimumPurse: 50,
        revision: 1,
        ...overrides,
    };
}

function dataset(records, overrides = {}) {
    return {
        schemaVersion: 1,
        context: {
            serverId: '12345678901234567',
            apiBaseUrl: 'https://dragsim.co/api/',
            mode: 'main',
        },
        completedAt: NOW,
        rosterObservedAt: NOW,
        includesNetworth: true,
        metrics: [],
        records,
        ...overrides,
    };
}

function record(username, networth, purse, overrides = {}) {
    return {
        username,
        rank: 'DEFAULT',
        uuid: `uuid-${username}`,
        profileId: `profile-${username}`,
        profileObservedAt: NOW,
        values: { networth, purse },
        approximate: {},
        ...overrides,
    };
}

function evidence(username = 'Low', overrides = {}) {
    return {
        profile: {
            username,
            uuid: `uuid-${username}`,
            profileId: `profile-${username}`,
            observedAt: NOW,
            profileSavedAt: NOW - 24 * 60 * 60_000,
            inventoryHidden: false,
            profile: { coins: 40 },
        },
        networth: {
            username,
            profileId: `profile-${username}`,
            total: 90,
            hidden: false,
            partial: false,
            observedAt: NOW,
            calculatedAt: NOW,
        },
        ...overrides,
    };
}

function fakeCommand(userId = 'admin') {
    const calls = [];
    const interaction = {
        guildId: '12345678901234567',
        channelId: '12345678901234568',
        user: { id: userId },
        calls,
        replied: false,
        deferred: false,
        async deferReply() {
            this.deferred = true;
            calls.push(['deferReply']);
        },
        async editReply(payload) {
            calls.push(['editReply', payload]);
            this.payload = payload;
            return { id: 'purge-message' };
        },
        async fetchReply() {
            return { id: 'purge-message' };
        },
        async reply(payload) {
            this.replied = true;
            calls.push(['reply', payload]);
        },
    };
    return interaction;
}

function componentInteraction(customId, actor = 'admin', extra = {}) {
    const calls = [];
    const interaction = {
        customId,
        guildId: '12345678901234567',
        channelId: '12345678901234568',
        user: { id: actor },
        message: { id: 'purge-message', guildId: '12345678901234567' },
        replied: false,
        deferred: false,
        calls,
        isStringSelectMenu: () => false,
        async deferUpdate() {
            this.deferred = true;
            calls.push(['deferUpdate']);
        },
        async editReply(payload) {
            calls.push(['editReply', payload]);
            this.payload = payload;
        },
        async followUp(payload) {
            calls.push(['followUp', payload]);
        },
        async reply(payload) {
            this.replied = true;
            calls.push(['reply', payload]);
        },
        ...extra,
    };
    return interaction;
}

test('purge candidate rules use either failure, inclusive equality, review-only unknowns and protected identities', () => {
    const roster = {
        members: ['Master', 'OnlyNetworth', 'OnlyPurse', 'Both', 'Equal', 'Unknown'],
        guildMaster: 'Master',
        observedAt: NOW,
    };
    const rows = buildPurgeRows(
        roster,
        dataset([
            record('Master', 1, 1),
            record('OnlyNetworth', 99, 50),
            record('OnlyPurse', 100, 49),
            record('Both', 99, 49),
            record('Equal', 100, 50),
        ]),
        settings(),
        [],
        'Bot',
        NOW
    );
    assert.deepEqual(
        rows.map((row) => [row.username, row.status]),
        [
            ['Both', 'eligible'],
            ['OnlyNetworth', 'eligible'],
            ['OnlyPurse', 'eligible'],
            ['Unknown', 'review'],
            ['Master', 'protected'],
        ]
    );
    assert.equal(
        rows.some((row) => row.username === 'Equal'),
        false
    );
});

test('partial networth policy is explicit and fresh evidence rejects unsafe timestamps or privacy', () => {
    const partial = dataset([record('Partial', 90, 40, { approximate: { networth: true } })]);
    runtimeEnv.PURGE_ALLOW_PARTIAL_NETWORTH = false;
    assert.equal(
        buildPurgeRows(
            { members: ['Partial'], observedAt: NOW },
            partial,
            settings(),
            [],
            undefined,
            NOW
        )[0].status,
        'review'
    );
    runtimeEnv.PURGE_ALLOW_PARTIAL_NETWORTH = true;
    assert.equal(
        buildPurgeRows(
            { members: ['Partial'], observedAt: NOW },
            partial,
            settings(),
            [],
            undefined,
            NOW
        )[0].status,
        'eligible'
    );
    runtimeEnv.PURGE_ALLOW_PARTIAL_NETWORTH = false;

    assert.equal(evaluateFreshPurgeEvidence('Low', evidence(), settings(), NOW).eligible, true);
    assert.equal(
        evaluateFreshPurgeEvidence(
            'Low',
            evidence('Low', { networth: { ...evidence().networth, hidden: true } }),
            settings(),
            NOW
        ).reviewOnly,
        true
    );
    assert.match(
        evaluateFreshPurgeEvidence(
            'Low',
            evidence('Low', {
                networth: { ...evidence().networth, calculatedAt: NOW - 6 * 60_000 },
            }),
            settings(),
            NOW
        ).reason,
        /older than 5 minutes/
    );
    assert.match(
        evaluateFreshPurgeEvidence(
            'Low',
            evidence('Low', {
                profile: { ...evidence().profile, observedAt: NOW + 2 * 60_000 },
            }),
            settings(),
            NOW
        ).reason,
        /future/
    );
});

test('kick capability parser accepts only strict server help entries', () => {
    assert.equal(parseKickCapabilityHelpLine('/g kick <player> - remove a member'), 'g');
    assert.equal(parseKickCapabilityHelpLine('Guild commands: /guild kick [username]'), 'guild');
    assert.equal(parseKickCapabilityHelpLine('Guild > [VIP] Player: /g kick <player>'), undefined);
    assert.equal(parseKickCapabilityHelpLine('Player: /guild kick <player>'), undefined);
});

test('purge exclusions are private, atomic, scoped and fail closed on corruption', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'guild-bridge-purge-'));
    const file = path.join(directory, 'purge.json');
    const store = new FilePurgeStore(file, () => NOW);
    await store.save('12345678901234567', ['Player_One']);
    assert.deepEqual(store.load('12345678901234567'), ['player_one']);
    assert.equal(fsSync.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fsSync.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => store.load('12345678901234568'), /different Discord guild/);
    await fs.writeFile(file, '{bad json');
    assert.throws(() => store.load('12345678901234567'), /JSON|schema/);
});

test('purge keeps the panel review-only until confirmation and verifies roster removal after each command', async () => {
    let currentRoster = {
        members: ['Master', 'Low', 'Good'],
        guildMaster: 'Master',
        observedAt: NOW,
    };
    let currentTime = NOW;
    const commands = [];
    const store = new MemoryPurgeStore();
    const service = new PurgeService({
        getSettings: () => settings(),
        authoriseInteraction: async () => true,
        getSnapshot: async () => ({
            roster: currentRoster,
            dataset: dataset([
                record('Master', 1, 1),
                record('Low', 90, 40),
                record('Good', 150, 60),
            ]),
        }),
        getRoster: async () => currentRoster,
        lookupFresh: async (username) => evidence(username),
        isMinecraftReady: () => true,
        getBotUsername: () => 'Bot',
        sendMinecraftCommand: (command) => {
            commands.push(command);
            if (command.startsWith('/g kick '))
                currentRoster = {
                    ...currentRoster,
                    members: currentRoster.members.filter((name) => name !== command.slice(8)),
                };
        },
        store,
        now: () => currentTime,
        sleep: async () => {},
    });
    await service.onMinecraftReady();
    assert.deepEqual(commands, ['/g help']);
    service.handleMinecraftMessage('§e/g kick <player> §7- remove a guild member');

    const command = fakeCommand();
    await service.handleCommand(command);
    const initial = command.payload;
    assert.match(initial.embeds[0].data.description, /Low/);
    assert.doesNotMatch(initial.embeds[0].data.description, /Good/);
    const purgeButton = initial.components.at(-1).components[0].data.custom_id;
    assert.equal(initial.components.at(-1).components[0].data.disabled, false);
    assert.deepEqual(commands, ['/g help']);

    const open = componentInteraction(purgeButton);
    await service.handleInteraction(open);
    assert.match(open.payload.embeds[0].data.title, /Confirm/);
    assert.match(open.payload.embeds[0].data.description, /Low/);
    assert.deepEqual(commands, ['/g help']);
    const confirmId = open.payload.components.at(-1).components[0].data.custom_id;

    const forged = componentInteraction(confirmId, 'other-admin');
    await service.handleInteraction(forged);
    assert.deepEqual(commands, ['/g help']);
    assert.match(forged.calls.at(-1)[1].content, /Only the administrator/);

    const confirm = componentInteraction(confirmId);
    await service.handleInteraction(confirm);
    assert.deepEqual(commands, ['/g help', '/g kick Low']);
    assert.match(confirm.payload.embeds[0].data.description, /1 removed/);
    currentTime += 11 * 60_000;
    const expired = componentInteraction(purgeButton);
    await service.handleInteraction(expired);
    assert.match(expired.calls.at(-1)[1].content, /expired|out of scope/);
    service.stop();
});

function control(payload, action) {
    const component = payload.components
        .flatMap((row) => row.components)
        .find((item) => item.data.custom_id?.split(':')[2] === action);
    assert.ok(component, `Missing ${action} control`);
    return component.data.custom_id;
}

async function harness(options = {}) {
    const state = {
        now: NOW,
        allowed: true,
        ready: true,
        settings: settings(),
        calls: [],
        members: ['Master', ...(options.members || ['Low', 'Other'])],
        removeOnKick: true,
        lookupHook: undefined,
    };
    const store = options.store || new MemoryPurgeStore();
    const roster = () => ({
        members: [...state.members],
        guildMaster: 'Master',
        observedAt: state.now,
    });
    const service = new PurgeService({
        getSettings: () => state.settings,
        authoriseInteraction: async () => state.allowed,
        getSnapshot: async () => ({
            roster: roster(),
            dataset: dataset(
                state.members.map((name) => record(name, 90, 40)),
                { completedAt: state.now }
            ),
        }),
        getRoster: async () => roster(),
        lookupFresh: async (username) => {
            if (state.lookupHook) return state.lookupHook(username);
            const value = evidence(username);
            value.profile.observedAt = state.now;
            value.networth.observedAt = state.now;
            value.networth.calculatedAt = state.now;
            return value;
        },
        isMinecraftReady: () => state.ready,
        getBotUsername: () => 'Bot',
        sendMinecraftCommand: (command) => {
            state.calls.push(command);
            if (state.removeOnKick && command.startsWith('/g kick '))
                state.members = state.members.filter((name) => name !== command.slice(8));
        },
        store,
        now: () => state.now,
        sleep: async () => {},
    });
    await service.onMinecraftReady();
    service.handleMinecraftMessage('/g kick <player> - kick a member');
    const command = fakeCommand();
    await service.handleCommand(command);
    const click = async (payload, action, extra = {}) => {
        const interaction = componentInteraction(control(payload, action), 'admin', extra);
        await service.handleInteraction(interaction);
        return interaction;
    };
    const prepare = async () => click(command.payload, 'open');
    const select = async (payload, username) =>
        click(payload, 'select', { isStringSelectMenu: () => true, values: [username] });
    return {
        state,
        service,
        store,
        command,
        click,
        prepare,
        select,
        kicks: () => state.calls.filter((c) => c.includes(' kick ')),
    };
}

test('purge paginates every row and dropdown, retaining exclusions across pages and concurrent updates', async () => {
    const h = await harness({
        members: Array.from({ length: 30 }, (_, i) => `Member${String(i).padStart(2, '0')}`),
    });
    try {
        const first = h.command.payload;
        assert.equal(first.components[0].components[0].toJSON().options.length, 25);
        assert.equal((first.embeds[0].data.description.match(/ — NW /g) || []).length, 25);
        assert.ok(first.embeds[0].data.description.length <= 4096);
        await Promise.all([h.select(first, 'Member00'), h.select(first, 'Member01')]);
        assert.deepEqual(h.store.snapshot(), ['member00', 'member01']);
        const next = await h.click(first, 'next');
        assert.ok(
            next.payload.components[0].components[0]
                .toJSON()
                .options.some((o) => o.value === 'Member29')
        );
        await h.select(next.payload, 'Member29');
        assert.ok(h.service.exclusions.includes('member29'));
        const previous = await h.click(next.payload, 'prev');
        await h.select(previous.payload, 'Member00');
        assert.ok(!h.service.exclusions.includes('member00'));
        assert.equal(h.kicks().length, 0);
    } finally {
        h.service.stop();
    }
});

test('purge confirms once and rejects stale confirmation tokens, other actors, expired or forged controls', async () => {
    const h = await harness();
    try {
        const old = await h.prepare();
        const fresh = await h.prepare();
        const stale = await h.click(old.payload, 'confirm');
        assert.match(stale.calls.at(-1)[1].content, /expired|replaced/);
        await h.click(fresh.payload, 'confirm', { channelId: '12345678901234569' });
        assert.equal(h.kicks().length, 0);
        const wrongActor = componentInteraction(control(fresh.payload, 'confirm'), 'other');
        await h.service.handleInteraction(wrongActor);
        assert.match(wrongActor.calls.at(-1)[1].content, /Only the administrator/);
        const id = control(fresh.payload, 'confirm');
        await Promise.all([
            h.service.handleInteraction(componentInteraction(id)),
            h.service.handleInteraction(componentInteraction(id)),
        ]);
        assert.deepEqual(h.kicks(), ['/g kick Low', '/g kick Other']);
    } finally {
        h.service.stop();
    }
    const expired = await harness();
    try {
        const prepared = await expired.prepare();
        expired.state.now += 121000;
        await expired.click(prepared.payload, 'confirm');
        assert.equal(expired.kicks().length, 0);
    } finally {
        expired.service.stop();
    }
});

test('purge invalidates confirmations when minimums or exclusions change and cancellation sends nothing', async () => {
    for (const change of ['minimums', 'exclusions', 'cancel']) {
        const h = await harness();
        try {
            const prepared = await h.prepare();
            if (change === 'minimums') h.state.settings = settings({ revision: 2 });
            if (change === 'exclusions') await h.select(h.command.payload, 'Low');
            if (change === 'cancel') await h.click(prepared.payload, 'cancel');
            await h.click(prepared.payload, 'confirm');
            assert.equal(h.kicks().length, 0, change);
        } finally {
            h.service.stop();
        }
    }
});

test('purge blocks destructive dispatch when authority or requirements change during a fresh lookup', async () => {
    for (const change of ['roles', 'minimums', 'disconnect', 'shutdown']) {
        const h = await harness();
        try {
            const prepared = await h.prepare();
            h.state.lookupHook = async (username) => {
                if (change === 'roles') h.state.allowed = false;
                if (change === 'minimums')
                    h.state.settings = settings({
                        minimumNetworth: 1,
                        minimumPurse: 1,
                        revision: 2,
                    });
                if (change === 'disconnect') h.service.onMinecraftDisconnected();
                if (change === 'shutdown') h.service.stop();
                return evidence(username);
            };
            await h.click(prepared.payload, 'confirm');
            assert.equal(h.kicks().length, 0, change);
        } finally {
            h.service.stop();
        }
    }
});

test('purge skips newly compliant targets, never adds newcomers and stops after an unconfirmed kick', async () => {
    const h = await harness();
    try {
        const prepared = await h.prepare();
        h.state.members.push('Newcomer');
        h.state.lookupHook = async (username) =>
            username === 'Low'
                ? evidence(username, {
                      profile: { ...evidence(username).profile, profile: { coins: 100 } },
                      networth: { ...evidence(username).networth, total: 200 },
                  })
                : evidence(username);
        h.state.removeOnKick = false;
        const result = await h.click(prepared.payload, 'confirm');
        assert.deepEqual(h.kicks(), ['/g kick Other']);
        assert.match(
            result.payload.embeds[0].data.description,
            /0 removed.*1 skipped.*1 unconfirmed/
        );
        assert.ok(h.state.members.includes('Newcomer'));
    } finally {
        h.service.stop();
    }
});

test('purge independently rejects commands and controls outside the staff channel', async () => {
    const h = await harness();
    try {
        const denied = fakeCommand();
        denied.channelId = '99999999999999999';
        await h.service.handleCommand(denied);
        assert.match(denied.calls.at(-1)[1].content, /permission/);
        const prepared = await h.prepare();
        const confirmation = await h.click(prepared.payload, 'confirm', {
            channelId: '99999999999999999',
        });
        assert.match(confirmation.calls.at(-1)[1].content, /permission/);
        // Changing the allowed channel invalidates an existing confirmation too.
        runtimeEnv.STAFF_COMMAND_CHANNEL_ID = '99999999999999999';
        await h.click(prepared.payload, 'confirm');
        assert.deepEqual(h.kicks(), []);
    } finally {
        runtimeEnv.STAFF_COMMAND_CHANNEL_ID = '12345678901234568';
        h.service.stop();
    }
});

test('purge denies missing role access and fails closed after an exclusion write failure', async () => {
    const h = await harness({
        store: {
            load: () => [],
            save: async () => {
                throw Error('disk full');
            },
        },
    });
    try {
        h.state.allowed = false;
        const denied = fakeCommand('member');
        await h.service.handleCommand(denied);
        assert.match(denied.calls.at(-1)[1].content, /permission/);
        h.state.allowed = true;
        const prepared = await h.prepare();
        await h.select(h.command.payload, 'Low');
        assert.match(h.service.storageError, /disk full/);
        await h.click(prepared.payload, 'confirm');
        assert.equal(h.kicks().length, 0);
    } finally {
        h.service.stop();
    }
});

test('permanent exclusions are hidden case-insensitively and cannot be restored from the dropdown', async () => {
    const previous = runtimeEnv.PURGE_PROTECTED_USERNAMES;
    runtimeEnv.PURGE_PROTECTED_USERNAMES = ['low'];
    const h = await harness();
    try {
        assert.doesNotMatch(h.command.payload.embeds[0].data.description, /\*\*Low\*\*/);
        assert.ok(
            !h.command.payload.components[0].components[0]
                .toJSON()
                .options.some((option) => option.value.toLowerCase() === 'low')
        );
        assert.equal(
            buildPurgeRows(
                { members: ['LOW'], observedAt: NOW },
                dataset([]),
                settings(),
                [],
                'Bot',
                NOW
            ).length,
            0
        );
        const forged = await h.select(h.command.payload, 'Low');
        assert.match(forged.calls.at(-1)[1].content, /visible/);
        assert.equal(
            evaluateFreshPurgeEvidence('LOW', evidence('LOW'), settings(), NOW).eligible,
            false
        );
    } finally {
        h.service.stop();
        runtimeEnv.PURGE_PROTECTED_USERNAMES = previous;
    }
});

test('permanent protection also blocks a player already present in a frozen confirmation', async () => {
    const previous = runtimeEnv.PURGE_PROTECTED_USERNAMES;
    const h = await harness();
    try {
        const prepared = await h.prepare();
        runtimeEnv.PURGE_PROTECTED_USERNAMES = ['low'];
        await h.click(prepared.payload, 'confirm');
        assert.deepEqual(h.kicks(), ['/g kick Other']);
    } finally {
        h.service.stop();
        runtimeEnv.PURGE_PROTECTED_USERNAMES = previous;
    }
});
