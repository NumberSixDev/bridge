import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import { z } from 'zod';
import { GUILD_ROSTER_REFRESH_MS } from '../leaderboard/roster';
import { STATS_MAX_STALE_MS, STATS_REFRESH_TIMEOUT_MS } from '../leaderboard/types';

const WRITE_INTERVAL_MS = 30_000;
const SNAPSHOT_MAX_AGE_MS = 90_000;
const MINECRAFT_STARTUP_GRACE_MS = 90_000;
const ROSTER_GRACE_MS = 30_000;
const AFK_GRACE_MS = 30_000;
const DATASET_WARMUP_MS = STATS_REFRESH_TIMEOUT_MS + 60_000;
const HEALTH_FILENAME = 'runtime-health.json';

const timestamp = z.number().int().nonnegative();
const snapshotSchema = z.object({
    version: z.literal(1),
    pid: z.number().int().positive(),
    startedAt: timestamp,
    updatedAt: timestamp,
    discord: z.object({
        ready: z.boolean(),
        registeredCommands: z.number().int().nonnegative(),
    }),
    minecraft: z.object({
        enabled: z.boolean(),
        ready: z.boolean(),
        connectedAt: timestamp.nullable(),
    }),
    afk: z.object({ configured: z.boolean(), active: z.boolean() }),
    leaderboard: z.object({
        rosterObservedAt: timestamp.nullable(),
        datasetCompletedAt: timestamp.nullable(),
        refreshing: z.boolean(),
    }),
});

type RuntimeSnapshot = z.infer<typeof snapshotSchema>;
type RuntimeStatus = Omit<RuntimeSnapshot, 'version' | 'pid' | 'startedAt' | 'updatedAt'>;

interface HealthCheckOptions {
    now: number;
    expectedPid?: number;
    minecraftEnabled: boolean;
    afkConfigured: boolean;
    isProcessAlive: (pid: number) => boolean;
}

type HealthResult = { status: 'healthy' | 'warming' | 'unhealthy'; message: string };

function unhealthy(message: string): HealthResult {
    return { status: 'unhealthy', message };
}

export function evaluateRuntimeHealth(value: unknown, options: HealthCheckOptions): HealthResult {
    const parsed = snapshotSchema.safeParse(value);
    if (!parsed.success) return unhealthy('The runtime snapshot is missing or invalid.');
    const { pid, startedAt, updatedAt, discord, minecraft, afk, leaderboard } = parsed.data;
    const { now } = options;
    if (
        updatedAt < startedAt ||
        updatedAt > now ||
        (minecraft.connectedAt !== null &&
            (minecraft.connectedAt < startedAt || minecraft.connectedAt > updatedAt)) ||
        (leaderboard.rosterObservedAt !== null &&
            (minecraft.connectedAt === null ||
                leaderboard.rosterObservedAt < minecraft.connectedAt ||
                leaderboard.rosterObservedAt > updatedAt)) ||
        (leaderboard.datasetCompletedAt !== null && leaderboard.datasetCompletedAt > updatedAt)
    )
        return unhealthy('The runtime snapshot contains inconsistent timestamps.');
    if (now - updatedAt > SNAPSHOT_MAX_AGE_MS) return unhealthy('The runtime snapshot is stale.');
    if (options.expectedPid !== undefined && pid !== options.expectedPid)
        return unhealthy('The runtime snapshot belongs to a different process.');
    if (!options.isProcessAlive(pid)) return unhealthy('The bridge process is no longer running.');
    if (minecraft.enabled !== options.minecraftEnabled || afk.configured !== options.afkConfigured)
        return unhealthy('The running bridge settings differ from the local configuration.');
    if (
        (minecraft.connectedAt !== null) !== minecraft.ready ||
        (!minecraft.enabled && minecraft.ready) ||
        (afk.active && (!afk.configured || !minecraft.ready))
    )
        return unhealthy('The runtime snapshot contains inconsistent connection states.');
    if (!discord.ready || discord.registeredCommands === 0)
        return unhealthy('Discord or its guild command handlers are unready.');

    const commands = `Discord ready with ${discord.registeredCommands} registered commands.`;
    if (!minecraft.enabled)
        return {
            status: 'healthy',
            message: `Healthy (Discord only, Minecraft paused). ${commands}`,
        };
    if (minecraft.connectedAt === null) {
        return now - startedAt <= MINECRAFT_STARTUP_GRACE_MS
            ? { status: 'warming', message: `${commands} Waiting for Minecraft to connect.` }
            : unhealthy('Minecraft is enabled and disconnected.');
    }

    const elapsed = now - minecraft.connectedAt;
    const rosterFresh =
        leaderboard.rosterObservedAt !== null &&
        now - leaderboard.rosterObservedAt <= GUILD_ROSTER_REFRESH_MS + ROSTER_GRACE_MS;
    const datasetFresh =
        leaderboard.datasetCompletedAt !== null &&
        now - leaderboard.datasetCompletedAt <= STATS_MAX_STALE_MS;
    const afkReady = !afk.configured || afk.active;
    if (!afkReady && elapsed > AFK_GRACE_MS)
        return unhealthy('Minecraft is connected but the configured AFK Rewards menu is inactive.');
    if (!rosterFresh && elapsed > ROSTER_GRACE_MS)
        return unhealthy('The Minecraft guild roster is missing or stale.');
    if (!datasetFresh && elapsed > DATASET_WARMUP_MS)
        return unhealthy('The full leaderboard cache is missing or stale.');
    if (!afkReady || !rosterFresh || !datasetFresh)
        return { status: 'warming', message: `${commands} Waiting for Minecraft data or AFK.` };

    const afkStatus = afk.active ? ' AFK Rewards is active.' : '';
    const refreshStatus = leaderboard.refreshing ? ' A refresh is in progress.' : '';
    return {
        status: 'healthy',
        message: `Healthy. ${commands} Minecraft is connected with a current guild roster and leaderboard cache.${afkStatus}${refreshStatus}`,
    };
}

export function readRuntimeHealth(dataDir: string): unknown {
    return JSON.parse(readFileSync(path.join(dataDir, HEALTH_FILENAME), 'utf8'));
}

export class RuntimeHealthReporter {
    private readonly startedAt = Date.now();
    private readonly filename: string;
    private timer?: ReturnType<typeof setInterval>;

    constructor(private readonly dataDir: string, private readonly sample: () => RuntimeStatus) {
        this.filename = path.join(dataDir, HEALTH_FILENAME);
    }

    public start() {
        if (this.timer) return;
        this.timer = setInterval(() => this.publish(), WRITE_INTERVAL_MS);
        this.timer.unref();
        this.publish();
    }

    public publish() {
        if (!this.timer) return;
        const temporary = path.join(this.dataDir, `runtime-health.${randomUUID()}.tmp`);
        try {
            const snapshot: RuntimeSnapshot = {
                version: 1,
                pid: process.pid,
                startedAt: this.startedAt,
                ...this.sample(),
                updatedAt: Date.now(),
            };
            mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
            writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600, flag: 'wx' });
            renameSync(temporary, this.filename);
        } catch {
            try {
                rmSync(temporary, { force: true });
            } catch {
                // An inaccessible directory also prevents removal.
            }
            winston.warn('The bridge could not update its local health snapshot.');
        }
    }

    public stop() {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = undefined;
        try {
            const snapshot = snapshotSchema.safeParse(readRuntimeHealth(this.dataDir));
            if (
                snapshot.success &&
                snapshot.data.pid === process.pid &&
                snapshot.data.startedAt === this.startedAt
            )
                rmSync(this.filename, { force: true });
        } catch {
            // A missing or unreadable file is already unusable by the checker.
        }
    }
}
