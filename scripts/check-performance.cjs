/* eslint-disable no-console */
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

// Offline measurements only: fake credentials, in-memory state and simulated API latency.
Object.assign(process.env, {
    MINECRAFT_EMAIL: 'bridge@example.test',
    DISCORD_TOKEN: 'test-token',
    DISCORD_SERVER_ID: '12345678901234567',
    MEMBER_CHANNEL_ID: '12345678901234568',
});
const Service = require('../dist/src/recruitment/service').default;
const Store = require('../dist/src/recruitment/memory-store').default;

async function measure() {
    let calls = 0;
    let active = 0;
    let peak = 0;
    let reports = 0;
    const store = new Store({
        version: 1,
        settings: { autoAcceptEnabled: false, minimumNetworth: 1, minimumPurse: 1 },
        applications: [],
    });
    const service = new Service({
        store,
        getChannel: () => undefined,
        isMinecraftReady: () => false,
        sendAcceptance: () => {
            throw Error('Performance check must not send guild commands');
        },
        lookup: {
            lookup: async (username) => {
                calls++;
                active++;
                peak = Math.max(peak, active);
                await new Promise((resolve) => setTimeout(resolve, 30));
                active--;
                const now = Date.now();
                return {
                    username,
                    playerUuid: 'id',
                    profileId: 'main',
                    profileName: 'Wise',
                    profileSavedAt: now,
                    calculatedAt: now,
                    marketObservedAt: now,
                    networth: 100,
                    purse: 10,
                    identityVerified: true,
                    coverageIssues: [],
                    hidden: false,
                    partial: false,
                    unpriced: 0,
                    uncertainValue: 0,
                };
            },
        },
    });
    try {
        const started = performance.now();
        await Promise.all(
            ['Applicant', 'APPLICANT', 'Second', 'Third'].map((username) =>
                service.handleEligibilityCommand({
                    options: { getString: () => username },
                    deferReply: async () => {},
                    editReply: async (payload) => {
                        assert.equal(payload.embeds?.length, 1);
                        reports++;
                    },
                    reply: async () => {
                        throw Error('Unexpected lookup rejection');
                    },
                })
            )
        );
        assert.equal(calls, 3, 'overlapping duplicate usernames must share one lookup');
        assert.equal(peak, 2, 'two lookups may run concurrently, never more');
        assert.equal(reports, 4);
        assert.deepEqual(store.snapshot().applications, []);
        return performance.now() - started;
    } finally {
        service.stop();
    }
}

(async () => {
    const durations = [];
    for (let i = 0; i < 5; i++) durations.push(await measure());
    durations.sort((a, b) => a - b);
    console.info(`Offline lookup benchmark: 4 searches, 3 API lookups, maximum 2 concurrent.`);
    console.info(
        `Median batch time: ${durations[2].toFixed(2)}ms with 30ms simulated API lookups.`
    );
    console.info('Real Discord/API latency is not measured by this offline check.');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
