/* eslint-disable no-console, import/no-unresolved, import/extensions */
const { config } = require('dotenv');
const { envSchema } = require('../dist/src/util/config.js');
const { evaluateRuntimeHealth, readRuntimeHealth } = require('../dist/src/util/runtime-health.js');

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function main(args) {
    const expectedPid = args.length ? Number(args[1]) : undefined;
    if (
        args.length > 0 &&
        (args.length !== 2 ||
            args[0] !== '--pid' ||
            !Number.isSafeInteger(expectedPid) ||
            expectedPid < 1)
    ) {
        console.error('Usage: pnpm check-health [--pid <bridge-process-id>]');
        return 1;
    }

    config({ quiet: true });
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
        console.error('Check the local configuration with pnpm check-config.');
        return 1;
    }
    let snapshot;
    try {
        snapshot = readRuntimeHealth(parsed.data.RECRUITMENT_DATA_DIR);
    } catch {
        console.error('The local runtime snapshot is missing or unreadable.');
        return 1;
    }
    const result = evaluateRuntimeHealth(snapshot, {
        now: Date.now(),
        expectedPid,
        minecraftEnabled: parsed.data.MINECRAFT_ENABLED,
        afkConfigured: parsed.data.MINECRAFT_AFK_ENABLED,
        isProcessAlive,
    });
    if (result.status === 'unhealthy') {
        console.error(result.message);
        return 1;
    }
    console.info(result.message);
    return 0;
}

process.exitCode = main(process.argv.slice(2));
