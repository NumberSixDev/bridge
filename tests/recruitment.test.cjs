const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
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
    RECRUITMENT_DATA_DIR: '.bridge-data-test',
    RECRUITMENT_CHANNEL_ID: '12345678901234568',
});

const { parseAmount, formatAmount } = require('../dist/src/recruitment/amount.js');
const { evaluateEligibility } = require('../dist/src/recruitment/policy.js');
const { FileRecruitmentStore } = require('../dist/src/recruitment/store.js');
const MemoryRecruitmentStore = require('../dist/src/recruitment/memory-store.js').default;
const { createDefaultRecruitmentState } = require('../dist/src/recruitment/types.js');
const RecruitmentService = require('../dist/src/recruitment/service.js').default;
const { DragSimLookupClient } = require('../dist/src/recruitment/api.js');

const NOW = 1_000_000_000_000;

function evidence(overrides = {}) {
    return {
        username: 'Applicant',
        playerUuid: 'uuid',
        profileId: 'profile',
        profileName: 'Main',
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

class FakeChannel {
    constructor() {
        this.id = '12345678901234568';
        this.guildId = '12345678901234567';
        this.messagesById = new Map();
        this.counter = 0;
        this.messages = {
            fetch: async (id) => {
                const message = this.messagesById.get(id);
                if (!message) throw new Error('Unknown Message');
                return message;
            },
        };
    }

    async send(payload) {
        const id = `12345678901234${String(++this.counter).padStart(3, '0')}`;
        const message = {
            id,
            channelId: this.id,
            guildId: this.guildId,
            payload,
            async edit(next) {
                this.payload = next;
                return this;
            },
        };
        this.messagesById.set(id, message);
        return message;
    }
}

function makeService({ lookupEvidence = evidence(), ready = true, state } = {}) {
    const store = new MemoryRecruitmentStore(
        state ?? {
            ...createDefaultRecruitmentState(),
            settings: { autoAcceptEnabled: false },
        }
    );
    const channel = new FakeChannel();
    const commands = [];
    let minecraftReady = ready;
    const service = new RecruitmentService({
        store,
        lookup: { lookup: async (username) => ({ ...lookupEvidence, username }) },
        now: () => NOW,
        getChannel: () => channel,
        isMinecraftReady: () => minecraftReady,
        sendAcceptance: (username) => commands.push(username),
    });
    return {
        service,
        store,
        channel,
        commands,
        setReady(value) {
            minecraftReady = value;
        },
    };
}

test('amount parsing accepts K/M/B/T and rejects unsafe or negative values', () => {
    assert.equal(parseAmount('15b'), 15_000_000_000);
    assert.equal(parseAmount('5.81m'), 5_810_000);
    assert.equal(parseAmount('250k'), 250_000);
    assert.equal(parseAmount('2t'), 2_000_000_000_000);
    assert.equal(parseAmount('1.5K'), 1500);
    assert.equal(parseAmount('2,000,000'), 2_000_000);
    assert.equal(parseAmount('none'), undefined);
    assert.throws(() => parseAmount('-1'), /non-negative/);
    assert.throws(() => parseAmount('Infinity'), /non-negative/);
    assert.throws(() => parseAmount('999999999999999999999T'), /safe number/);
});

test('display amounts use lowercase compact units and truncate at two decimal places', () => {
    assert.equal(formatAmount(1_217_130_121.333), '1.21b');
    assert.equal(formatAmount(5_812_272), '5.81m');
    assert.equal(formatAmount(15_000_000_000), '15b');
    assert.equal(formatAmount(1_010_000_000), '1.01b');
    assert.equal(formatAmount(999_999), '999.99k');
    assert.equal(formatAmount(1e12), '1t');
    assert.equal(formatAmount(0), '0');
    assert.equal(formatAmount(undefined), 'Not set');
});

test('eligibility is off by default, inclusive at both thresholds, and fails closed for incomplete data', () => {
    const settings = { autoAcceptEnabled: true, minimumNetworth: 500, minimumPurse: 100 };
    assert.equal(
        evaluateEligibility(evidence(), { ...settings, autoAcceptEnabled: false }, NOW).eligible,
        false
    );
    assert.equal(evaluateEligibility(evidence(), settings, NOW).eligible, true);
    assert.equal(evaluateEligibility(evidence({ partial: true }), settings, NOW).eligible, false);
    assert.equal(
        evaluateEligibility(evidence({ profileSavedAt: NOW - 5 * 60_000 - 1 }), settings, NOW)
            .eligible,
        false
    );
    assert.equal(evaluateEligibility(evidence({ networth: 499 }), settings, NOW).eligible, false);
});

test('recruitment persists applications, suppresses duplicates, and never retroactively auto-accepts', async () => {
    const harness = makeService();
    await harness.service.handleJoinRequest('Applicant');
    await harness.service.handleJoinRequest('APPLICANT');
    let snapshot = harness.store.snapshot();
    assert.equal(snapshot.applications.length, 1);
    assert.equal(snapshot.applications[0].status, 'pending');
    assert.deepEqual(harness.commands, []);

    await harness.service.setMinimums('500', '100');
    await harness.service.setAutoEnabled(true);
    snapshot = harness.store.snapshot();
    assert.equal(snapshot.settings.autoAcceptEnabled, true);
    assert.deepEqual(
        harness.commands,
        [],
        'changing settings does not reprocess an existing application'
    );

    await harness.service.handleJoinRequest('SecondApplicant');
    snapshot = harness.store.snapshot();
    assert.deepEqual(harness.commands, ['SecondApplicant']);
    assert.equal(
        snapshot.applications.find((item) => item.username === 'SecondApplicant').status,
        'acceptance-sent'
    );
});

test('partial valuation goes to manual review and deny is local only', async () => {
    const harness = makeService({
        lookupEvidence: evidence({ partial: true, coverageIssues: ['partial'] }),
    });
    await harness.service.setMinimums('1', '1');
    await harness.service.setAutoEnabled(true);
    await harness.service.handleJoinRequest('PartialPlayer');
    const application = harness.store.snapshot().applications[0];
    assert.equal(application.status, 'pending');
    assert.deepEqual(harness.commands, []);
    const result = await harness.service.decide(application.id, 'deny', 'moderator');
    assert.equal(result.ok, true);
    assert.match(result.message, /no Minecraft decline command/i);
    assert.equal(harness.store.snapshot().applications[0].status, 'denied');
    await harness.service.handleJoinRequest('PartialPlayer');
    assert.equal(harness.store.snapshot().applications.length, 1);
});

test('automatic acceptance waits for readiness and sends at most one command', async () => {
    const harness = makeService({ ready: false });
    await harness.service.setMinimums('500', '100');
    await harness.service.setAutoEnabled(true);
    await harness.service.handleJoinRequest('OfflinePlayer');
    let application = harness.store.snapshot().applications[0];
    assert.equal(application.status, 'pending');
    assert.match(application.deliveryIssue, /not connected/i);
    assert.deepEqual(harness.commands, []);
    harness.setReady(true);
    await harness.service.onMinecraftReady();
    await harness.service.onMinecraftReady();
    application = harness.store.snapshot().applications[0];
    assert.equal(application.status, 'acceptance-sent');
    assert.deepEqual(harness.commands, ['OfflinePlayer']);
});

test('an uncertain acceptance is not resent after restart', async () => {
    const initial = createDefaultRecruitmentState();
    initial.applications.push({
        id: 'uncertain',
        username: 'CrashPlayer',
        usernameKey: 'crashplayer',
        receivedAt: NOW,
        status: 'accepting',
        lookupStatus: 'complete',
        coverageIssues: [],
        thresholdAutoEnabled: true,
        autoCandidate: true,
    });
    const harness = makeService({ state: initial });
    await new Promise((resolve) => setImmediate(resolve));
    const application = harness.store.snapshot().applications[0];
    assert.equal(application.status, 'needs-verification');
    assert.deepEqual(harness.commands, []);
});

test('the API client fetches the selected profile before its matching networth and rejects identity mismatch', async () => {
    const calls = [];
    const responses = [
        {
            mode: 'main',
            player: { player: 'Applicant', uuid: 'uuid' },
            profiles: [{ id: 'profile', name: 'Main', selected: true }],
            profile: {
                id: 'profile',
                profile_name: 'Main',
                profile_mode: 'NORMAL',
                inventory_hidden: false,
                coins: 100,
                updated_at: NOW,
            },
        },
        {
            mode: 'main',
            hidden: false,
            partial: false,
            profile_id: 'profile',
            profile_saved_at: NOW,
            calculated_at: NOW,
            market_observed_at: NOW,
            total: 500,
            unpriced: 0,
            uncertain_value: 0,
        },
    ];
    const client = new DragSimLookupClient({
        baseUrl: 'https://dragsim.co/api/',
        fetcher: async (url) => {
            calls.push(url.toString());
            return new Response(JSON.stringify(responses.shift()), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        },
    });
    const result = await client.lookup('Applicant');
    assert.equal(result.networth, 500);
    assert.equal(result.purse, 100);
    assert.match(calls[0], /\/api\/player\/Applicant\?mode=main/);
    assert.match(calls[1], /\/api\/networth\/Applicant\?mode=main&profile=profile/);

    const badClient = new DragSimLookupClient({
        baseUrl: 'https://dragsim.co/api/',
        fetcher: async () =>
            new Response(JSON.stringify({ player: { player: 'Other' }, profiles: [] }), {
                status: 200,
            }),
    });
    await assert.rejects(() => badClient.lookup('Applicant'), /different player identity/);
});

test('corrupt recruitment storage fails closed without replacing the file', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'guild-bridge-recruitment-'));
    const file = path.join(directory, 'recruitment.json');
    await fs.writeFile(file, '{not-json');
    const store = new FileRecruitmentStore(file);
    assert.throws(() => store.load(), /Unexpected token|JSON/);
});

const interactionEvent = require('../dist/src/discord/events/interaction-create.js').default;
const recruitmentCommand = require('../dist/src/discord/commands/recruitment.js').default;

function fakeInteraction(
    harness,
    {
        type = 'button',
        customId,
        roles = ['1569762077592125510'],
        channelId = '12345678901234568',
        guildId = '12345678901234567',
        message,
        subcommand = 'status',
        fields = {},
    } = {}
) {
    const result = { replies: [], shownModal: null, rolesFetched: 0 };
    const interaction = {
        guildId,
        channelId,
        customId,
        message,
        user: { id: '12345678901234569' },
        guild: {
            members: {
                fetch: async () => {
                    result.rolesFetched += 1;
                    return { roles: { cache: new Map(roles.map((id) => [id, {}])) } };
                },
            },
        },
        member: { roles: { cache: new Map() } },
        inCachedGuild: () => true,
        isButton: () => type === 'button',
        isModalSubmit: () => type === 'modal',
        isChatInputCommand: () => type === 'command',
        commandName: 'recruitment',
        options: {
            data: [],
            getSubcommand: () => subcommand,
            getString: (key) => fields[key],
            getBoolean: () => fields.enabled,
        },
        fields: { getTextInputValue: (key) => fields[key] ?? '' },
        async reply(payload) {
            result.replies.push(payload);
            this.replied = true;
        },
        async editReply(payload) {
            result.replies.push(payload);
        },
        async followUp(payload) {
            result.replies.push(payload);
        },
        async deferReply() {
            this.deferred = true;
        },
        async deferUpdate() {
            this.deferred = true;
        },
        async showModal(modal) {
            result.shownModal = modal;
            this.replied = true;
        },
    };
    return {
        interaction,
        result,
        run: () =>
            interactionEvent.run(
                {
                    recruitment: harness.service,
                    discord: { commands: new Map([['recruitment', recruitmentCommand]]) },
                },
                interaction
            ),
    };
}

test('recruitment commands, buttons and modals enforce the two roles with no owner/staff bypass', async () => {
    const h = makeService();
    for (const type of ['command', 'button', 'modal']) {
        const test = fakeInteraction(h, {
            type,
            customId: 'recruitment:panel:requirements',
            roles: [],
        });
        await test.run();
        assert.equal(test.result.rolesFetched, 1);
        assert.match(test.result.replies[0].embeds[0].data.description, /permission/);
    }
    for (const role of ['1569762077592125510', '1569548424884387850']) {
        const test = fakeInteraction(h, { type: 'command', roles: [role] });
        await test.run();
        assert.equal(test.interaction.deferred, true);
        assert.match(test.result.replies[0].content, /Disabled/i);
    }
    const wrongGuild = fakeInteraction(h, { type: 'command', guildId: '99999999999999999' });
    await wrongGuild.run();
    assert.equal(wrongGuild.result.rolesFetched, 0);
    assert.deepEqual(h.service.settings, { autoAcceptEnabled: false });
});

test('settings panel opens a modal, persists changes, toggles auto mode and rejects forged controls', async () => {
    const h = makeService();
    const panelCommand = fakeInteraction(h, { type: 'command', subcommand: 'panel' });
    await panelCommand.run();
    const message = h.channel.messagesById.get(h.service.settings.panelMessageId);
    assert.ok(message);
    assert.ok(
        panelCommand.result.replies[0].content.includes(
            `https://discord.com/channels/${h.channel.guildId}/${h.channel.id}/${message.id}`
        )
    );
    const edit = fakeInteraction(h, { customId: 'recruitment:panel:edit', message });
    await edit.run();
    assert.equal(edit.result.shownModal.data.title, 'Recruitment minimums');
    const modal = fakeInteraction(h, {
        type: 'modal',
        customId: 'recruitment:panel:requirements',
        message,
        fields: { minimum_networth: '1b', minimum_purse: '10m' },
    });
    await modal.run();
    assert.equal(h.store.snapshot().settings.minimumNetworth, 1e9);
    assert.equal(h.store.snapshot().settings.minimumPurse, 1e7);
    const toggle = fakeInteraction(h, { customId: 'recruitment:panel:auto:enable', message });
    await toggle.run();
    assert.equal(h.service.settings.autoAcceptEnabled, true);
    for (const options of [
        {
            customId: 'recruitment:panel:auto:enable',
            message: { ...message, id: '99999999999999999' },
        },
        { customId: 'recruitment:panel:auto:enable', message, channelId: '99999999999999999' },
        {
            type: 'modal',
            customId: 'recruitment:panel:requirements',
            message: { ...message, id: '99999999999999999' },
            fields: { minimum_networth: '0', minimum_purse: '0' },
        },
    ]) {
        await fakeInteraction(h, options).run();
        assert.equal(h.service.settings.minimumNetworth, 1e9);
        assert.equal(h.service.settings.autoAcceptEnabled, true);
    }
    await Promise.all([
        fakeInteraction(h, { customId: 'recruitment:panel:auto:disable', message }).run(),
        fakeInteraction(h, { customId: 'recruitment:panel:auto:disable', message }).run(),
    ]);
    assert.equal(h.service.settings.autoAcceptEnabled, false);
});

test('concurrent application clicks send one acceptance; disconnected, forged and wrong-channel clicks do not send', async () => {
    const h = makeService({ ready: false });
    await h.service.handleJoinRequest('Applicant');
    let app = h.store.snapshot().applications[0];
    const message = h.channel.messagesById.get(app.messageId);
    const options = { customId: `recruitment:application:${app.id}:accept`, message };
    await fakeInteraction(h, options).run();
    assert.equal(h.store.snapshot().applications[0].status, 'pending');
    h.setReady(true);
    await fakeInteraction(h, {
        ...options,
        message: { ...message, id: '99999999999999999' },
    }).run();
    await fakeInteraction(h, { ...options, channelId: '99999999999999999' }).run();
    assert.deepEqual(h.commands, []);
    await Promise.all([fakeInteraction(h, options).run(), fakeInteraction(h, options).run()]);
    assert.deepEqual(h.commands, ['Applicant']);
    app = h.store.snapshot().applications[0];
    assert.equal(app.status, 'acceptance-sent');
    assert.ok(message.payload.components[0].components.every((button) => button.data.disabled));
});

test('changing or disabling settings during lookup prevents automatic acceptance', async () => {
    for (const change of ['disable', 'enable']) {
        const h = makeService();
        await h.service.setMinimums('1', '1');
        if (change === 'disable') await h.service.setAutoEnabled(true);
        let release;
        h.service.lookup = {
            lookup: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        };
        const pending = h.service.handleJoinRequest('Applicant');
        while (!release) await new Promise((resolve) => setImmediate(resolve));
        await h.service.setAutoEnabled(change === 'enable');
        release(evidence());
        await pending;
        assert.deepEqual(h.commands, []);
        assert.equal(h.store.snapshot().applications[0].status, 'pending');
    }
});

test('restart resumes interrupted lookups, preserves review cards, and never accepts the old request automatically', async () => {
    const original = makeService();
    await original.service.handleJoinRequest('Applicant');
    const state = original.store.snapshot();
    state.settings = { autoAcceptEnabled: true, minimumNetworth: 1, minimumPurse: 1, revision: 0 };
    state.applications[0].lookupStatus = 'pending';
    state.applications[0].settingsRevision = 0;
    const restarted = makeService({ state });
    // Model a fresh gateway client which fetches an existing Discord message.
    restarted.channel.messagesById = original.channel.messagesById;
    await restarted.service.onDiscordReady();
    assert.equal(restarted.store.snapshot().applications[0].lookupStatus, 'complete');
    assert.equal(
        restarted.store.snapshot().applications[0].messageId,
        state.applications[0].messageId
    );
    assert.deepEqual(restarted.commands, []);
});

test('Discord delivery failure retains the application and retries without duplicate cards', async () => {
    const h = makeService();
    const send = h.channel.send.bind(h.channel);
    let fail = true;
    h.channel.send = async (payload) => {
        if (fail) throw new Error('Discord temporarily unavailable');
        return send(payload);
    };
    await h.service.handleJoinRequest('Applicant');
    assert.equal(h.store.snapshot().applications[0].status, 'pending');
    assert.equal(h.store.snapshot().applications[0].messageId, undefined);
    fail = false;
    const id = h.store.snapshot().applications[0].id;
    await Promise.all([h.service.deliverApplicationCard(id), h.service.deliverApplicationCard(id)]);
    assert.equal(h.channel.messagesById.size, 1);
    h.service.stop();
});

test('atomic disk state preserves settings and pending requests with private permissions', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'guild-recruitment-'));
    try {
        const file = path.join(directory, 'data', 'recruitment.json');
        const store = new FileRecruitmentStore(file);
        const h = makeService();
        await h.service.setMinimums('1B', '10M');
        await h.service.handleJoinRequest('Applicant');
        await store.save(h.store.snapshot());
        assert.deepEqual(store.load(), JSON.parse(JSON.stringify(h.store.snapshot())));
        assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
        assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('failed durable write prevents acceptance and cannot silently reset enabled state', async () => {
    const h = makeService();
    await h.service.handleJoinRequest('Applicant');
    const id = h.store.snapshot().applications[0].id;
    h.store.save = async () => {
        throw new Error('Disk unavailable');
    };
    await assert.rejects(() => h.service.decide(id, 'manual-accept', 'admin'), /Disk unavailable/);
    assert.deepEqual(h.commands, []);
    await assert.rejects(() => h.service.setAutoEnabled(false), /storage is unavailable/);
});

test('missing, private, stale, uncertain or malformed data always remains manual', () => {
    const settings = { autoAcceptEnabled: true, minimumNetworth: 500, minimumPurse: 100 };
    for (const invalid of [
        { identityVerified: false },
        { hidden: true },
        { partial: true },
        { unpriced: 1 },
        { uncertainValue: 1 },
        { purse: undefined },
        { networth: undefined },
        { calculatedAt: undefined },
        { marketObservedAt: NOW - 300001 },
        { profileSavedAt: NOW + 60001 },
        { coverageIssues: ['Wrong profile mode'] },
    ])
        assert.equal(evaluateEligibility(evidence(invalid), settings, NOW).eligible, false);
});

test('panel follows the invoking channel while applications keep their separately configured channel', async () => {
    const h = makeService();
    const other = new FakeChannel();
    other.id = '99999999999999999';
    h.service.resolveChannel = async (id) =>
        [h.channel, other].find((channel) => channel.id === id);
    await fakeInteraction(h, { type: 'command', subcommand: 'panel' }).run();
    const oldMessage = h.channel.messagesById.get(h.service.settings.panelMessageId);
    await fakeInteraction(h, { type: 'command', subcommand: 'panel', channelId: other.id }).run();
    assert.equal(h.service.settings.panelChannelId, other.id);
    assert.deepEqual(oldMessage.payload.components, []);
    const newMessage = other.messagesById.get(h.service.settings.panelMessageId);
    const edit = fakeInteraction(h, {
        customId: 'recruitment:panel:edit',
        channelId: other.id,
        message: newMessage,
    });
    await edit.run();
    assert.ok(edit.result.shownModal);
    await h.service.handleJoinRequest('Applicant');
    const application = h.store.snapshot().applications[0];
    assert.equal(application.channelId, h.channel.id);
    assert.ok(h.channel.messagesById.has(application.messageId));
});

test('startup and settings changes never create a panel before the panel command', async () => {
    const h = makeService();
    await h.service.onDiscordReady();
    await h.service.setMinimums('1B', '100M');
    await h.service.setAutoEnabled(true);
    assert.equal(h.channel.messagesById.size, 0);
    assert.equal(h.service.settings.panelMessageId, undefined);
});

test('a deleted panel is forgotten on restart and is not automatically reposted', async () => {
    const h = makeService({
        state: {
            ...createDefaultRecruitmentState(),
            settings: {
                autoAcceptEnabled: false,
                panelChannelId: '12345678901234568',
                panelMessageId: '12345678901234001',
            },
        },
    });
    h.channel.messages.fetch = async () => {
        throw Object.assign(new Error('Unknown Message'), { code: 10008 });
    };
    await h.service.onDiscordReady();
    assert.equal(h.service.settings.panelMessageId, undefined);
    assert.equal(h.channel.messagesById.size, 0);
    assert.equal(h.service.settings.autoAcceptEnabled, false);
});

const { applicationReport, cleanProfileName } = require('../dist/src/recruitment/presentation.js');

test('profile display strips Minecraft colour and formatting codes', () => {
    assert.equal(cleanProfileName('§7Wise'), 'Wise');
    assert.equal(cleanProfileName('§a§lStrong§r'), 'Strong');
    assert.equal(cleanProfileName('§x§1§2§3§4§5§6Wise'), 'Wise');
    assert.equal(cleanProfileName('§#abcdefWise'), 'Wise');
    assert.equal(cleanProfileName('§7', 'profile-id'), 'profile-id');
});

test('application reports compare both requirements and offer advice even with auto acceptance off', () => {
    const settings = { autoAcceptEnabled: false, minimumNetworth: 500, minimumPurse: 100 };
    const above = applicationReport(evidence(), settings, NOW).join('\n');
    assert.match(above, /Networth = \*\*✅ Meets requirement/);
    assert.match(above, /Purse = \*\*✅ Meets requirement/);
    assert.match(above, /Suggestion = \*\*Accept\*\*/);
    const below = applicationReport(evidence({ networth: 499, purse: 99 }), settings, NOW).join(
        '\n'
    );
    assert.match(below, /Networth = \*\*❌ Under requirement/);
    assert.match(below, /Purse = \*\*❌ Under requirement/);
    assert.match(below, /Below minimums/);
    for (const invalid of [
        { partial: true },
        { hidden: true },
        { purse: undefined },
        { profileSavedAt: NOW - 300001 },
    ]) {
        assert.match(
            applicationReport(evidence(invalid), settings, NOW).join('\n'),
            /Suggestion = \*\*Manual review/
        );
    }
    assert.match(
        applicationReport(evidence(), { autoAcceptEnabled: false }, NOW).join('\n'),
        /Minimum not set/
    );
});

test('application embeds show clean profiles and refresh their report when minimums change', async () => {
    const h = makeService({ lookupEvidence: evidence({ profileName: '§7Wise' }) });
    await h.service.setMinimums('500', '100');
    await h.service.handleJoinRequest('Applicant');
    const application = h.store.snapshot().applications[0];
    const message = h.channel.messagesById.get(application.messageId);
    assert.match(
        message.payload.embeds[0].data.description,
        /^Networth = \*\*✅ Meets requirement/
    );
    assert.match(message.payload.embeds[0].data.description, /Profile: \*\*Wise\*\*/);
    await h.service.setMinimums('501', '101');
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(
        message.payload.embeds[0].data.description,
        /^Networth = \*\*❌ Under requirement/
    );
    assert.deepEqual(h.commands, []);
});
