const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    evaluateRuntimeHealth,
    readRuntimeHealth,
    RuntimeHealthReporter,
} = require('../dist/src/util/runtime-health.js');

const NOW = 1_800_000_000_000;
const PID = 42;
const READY = NOW - 20 * 60_000;
const STARTED = READY - 60_000;
const healthyStatus = {
    discord: { ready: true, registeredCommands: 9 },
    minecraft: { enabled: true, ready: true, connectedAt: READY },
    afk: { configured: true, active: true },
    leaderboard: {
        rosterObservedAt: NOW - 60_000,
        datasetCompletedAt: NOW - 120_000,
        refreshing: false,
    },
};
const pausedStatus = {
    ...healthyStatus,
    minecraft: { enabled: false, ready: false, connectedAt: null },
    afk: { configured: true, active: false },
    leaderboard: { rosterObservedAt: null, datasetCompletedAt: null, refreshing: false },
};

function evaluate(overrides, options = {}) {
    return evaluateRuntimeHealth(
        {
            version: 1,
            pid: PID,
            startedAt: STARTED,
            updatedAt: NOW,
            ...healthyStatus,
            ...overrides,
        },
        {
            now: NOW,
            minecraftEnabled: true,
            afkConfigured: true,
            isProcessAlive: () => true,
            ...options,
        }
    );
}

test('health rejects missing, stale, dead and mismatched snapshots', () => {
    assert.match(evaluate({ version: null }).message, /missing or invalid/);
    assert.match(evaluate({ ...pausedStatus, updatedAt: NOW - 100_000 }).message, /stale/);
    assert.match(evaluate({}, { isProcessAlive: () => false }).message, /no longer running/);
    assert.match(evaluate({}, { expectedPid: PID + 1 }).message, /different process/);
    assert.match(evaluate({}, { minecraftEnabled: false }).message, /differ from.*configuration/);
    assert.match(evaluate({}, { afkConfigured: false }).message, /differ from.*configuration/);
    assert.match(evaluate({ updatedAt: NOW + 1 }).message, /inconsistent timestamps/);
    assert.match(evaluate({ discord: { ready: false, registeredCommands: 9 } }).message, /unready/);
    assert.equal(evaluate({ discord: { ready: true, registeredCommands: 0 } }).status, 'unhealthy');
});

test('health distinguishes an intentional pause from enabled Minecraft and AFK failures', () => {
    const paused = evaluate(pausedStatus, { minecraftEnabled: false });
    assert.equal(paused.status, 'healthy');
    assert.match(paused.message, /Discord only, Minecraft paused/);

    const connecting = {
        ...pausedStatus,
        minecraft: { enabled: true, ready: false, connectedAt: null },
    };
    assert.equal(evaluate({ ...connecting, startedAt: NOW - 20_000 }).status, 'warming');
    assert.match(evaluate(connecting).message, /enabled and disconnected/);
    assert.match(
        evaluate({ afk: { configured: true, active: false } }).message,
        /AFK Rewards menu is inactive/
    );
});

test('health allows a cold dataset to warm and detects stale roster or full cache', () => {
    assert.equal(evaluate({}).status, 'healthy');
    const warming = {
        minecraft: { enabled: true, ready: true, connectedAt: NOW - 240_000 },
        leaderboard: { ...healthyStatus.leaderboard, datasetCompletedAt: null, refreshing: true },
    };
    assert.equal(evaluate(warming).status, 'warming');
    assert.match(
        evaluate({ leaderboard: warming.leaderboard }).message,
        /leaderboard cache is missing or stale/
    );
    assert.match(
        evaluate({
            leaderboard: { ...healthyStatus.leaderboard, datasetCompletedAt: NOW - 16 * 60_000 },
        }).message,
        /leaderboard cache is missing or stale/
    );
    assert.match(
        evaluate({
            leaderboard: { ...healthyStatus.leaderboard, rosterObservedAt: NOW - 11 * 60_000 },
        }).message,
        /guild roster is missing or stale/
    );
});

test('the reporter writes a private snapshot and removes it on stop, and the CLI checks the live PID', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-health-'));
    const dataDir = path.join(root, 'runtime');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const env = {
        ...process.env,
        RECRUITMENT_DATA_DIR: dataDir,
        MINECRAFT_EMAIL: 'bridge@example.test',
        MINECRAFT_ENABLED: 'false',
        MINECRAFT_AFK_ENABLED: 'true',
        DISCORD_TOKEN: 'test-token',
        DISCORD_SERVER_ID: '12345678901234567',
        MEMBER_CHANNEL_ID: '12345678901234568',
    };
    const check = (...args) =>
        spawnSync(process.execPath, ['scripts/check-health.cjs', ...args], {
            env,
            encoding: 'utf8',
        });
    assert.equal(check().status, 1);

    const reporter = new RuntimeHealthReporter(dataDir, () => pausedStatus);
    reporter.start();
    try {
        const snapshot = readRuntimeHealth(dataDir);
        assert.equal(snapshot.pid, process.pid);
        assert.equal(fs.statSync(path.join(dataDir, 'runtime-health.json')).mode & 0o777, 0o600);
        assert.deepEqual(fs.readdirSync(dataDir), ['runtime-health.json']);
        const current = check('--pid', String(process.pid));
        assert.equal(current.status, 0);
        assert.match(current.stdout, /Discord only, Minecraft paused/);
        assert.equal(check('--pid', String(process.pid + 1)).status, 1);
    } finally {
        reporter.stop();
    }
    reporter.publish();
    assert.deepEqual(fs.readdirSync(dataDir), []);
    assert.equal(check().status, 1);
});
