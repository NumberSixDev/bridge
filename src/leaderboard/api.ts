/* eslint-disable max-classes-per-file, no-await-in-loop, no-constant-condition */

import env from '@util/env';
import { LeaderboardLookupClient, NetworthSnapshot, ProfileSnapshot } from './types';

const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,16}$/;
const MAX_RESPONSE_BYTES = 6_000_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RETRY_DELAY_MS = 2_000;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as JsonObject)
        : undefined;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
    return typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= Number.MAX_SAFE_INTEGER
        ? value
        : undefined;
}

function timestamp(value: unknown): number | undefined {
    const number = numberValue(value);
    if (number === undefined) return undefined;
    return number < 10_000_000_000 ? number * 1_000 : number;
}

interface QueueTask {
    run: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
}

class RequestLimiter {
    private active = 0;
    private readonly queue: QueueTask[] = [];

    public constructor(private readonly limit: number) {}

    public run<T>(run: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.queue.push({
                run: () => run(),
                resolve: (value) => resolve(value as T),
                reject,
            });
            this.drain();
        });
    }

    private drain() {
        while (this.active < this.limit && this.queue.length) {
            const task = this.queue.shift()!;
            this.active += 1;
            task.run()
                .then(task.resolve, task.reject)
                .finally(() => {
                    this.active -= 1;
                    this.drain();
                });
        }
    }
}

export interface LeaderboardApiOptions {
    baseUrl?: string;
    fetcher?: typeof fetch;
    timeoutMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
}

export class DragSimLeaderboardClient implements LeaderboardLookupClient {
    private readonly baseUrl: URL;
    private readonly fetcher: typeof fetch;
    private readonly timeoutMs: number;
    private readonly sleep: (milliseconds: number) => Promise<void>;
    private readonly now: () => number;
    private readonly limiter = new RequestLimiter(2);
    private retryAfterAt = 0;

    public constructor(options: LeaderboardApiOptions = {}) {
        const baseUrl = new URL(options.baseUrl ?? env.RECRUITMENT_API_BASE_URL);
        if (baseUrl.protocol !== 'https:') throw new Error('Leaderboard API must use HTTPS.');
        if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
        this.baseUrl = baseUrl;
        this.fetcher = options.fetcher ?? fetch;
        this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
        this.sleep =
            options.sleep ??
            ((milliseconds) =>
                new Promise((resolve) => {
                    setTimeout(resolve, milliseconds);
                }));
        this.now = options.now ?? Date.now;
    }

    public async getProfile(username: string): Promise<ProfileSnapshot> {
        this.assertUsername(username);
        const url = new URL(`player/${encodeURIComponent(username)}?mode=main`, this.baseUrl);
        const data = await this.getJson(url);
        if (data.mode !== 'main') throw new Error('The profile API did not return the main mode.');

        const player = object(data.player);
        const returnedUsername = stringValue(player?.player) ?? stringValue(data.username);
        if (!returnedUsername || returnedUsername.toLowerCase() !== username.toLowerCase()) {
            throw new Error('The profile API returned a different player identity.');
        }
        const uuid = stringValue(player?.uuid);
        if (!uuid || uuid.length > 100)
            throw new Error('The profile API returned an invalid UUID.');

        const profiles = Array.isArray(data.profiles)
            ? data.profiles.map(object).filter((value): value is JsonObject => value !== undefined)
            : [];
        const selected = object(data.profile);
        const profileId = stringValue(selected?.id);
        const selectedEntry = profiles.find((profile) => stringValue(profile.id) === profileId);
        if (
            !profileId ||
            profileId.length > 100 ||
            !selectedEntry ||
            selectedEntry.selected !== true ||
            selected?.profile_mode !== 'NORMAL'
        ) {
            throw new Error('The profile API did not return a matching selected main profile.');
        }

        if (typeof selected.inventory_hidden !== 'boolean')
            throw new Error('The profile API did not return a verified privacy status.');
        return {
            username,
            rank: stringValue(player?.rank)?.slice(0, 32),
            uuid,
            profileId,
            profileName: stringValue(selected?.name) ?? stringValue(selected?.profile_name),
            profileSavedAt: timestamp(selected?.updated_at),
            observedAt: timestamp(data.fetched_at) ?? this.now(),
            inventoryHidden: selected?.inventory_hidden === true,
            profile: Object.fromEntries(
                Object.entries(selected).filter(([key]) =>
                    [
                        'coins',
                        'motes',
                        'bits',
                        'haunted_candy_earned',
                        'dragon_essence',
                        'draconic_experience',
                        'skills',
                        'collections',
                        'bestiary',
                        'slayer',
                        'dungeons',
                        'hotd',
                        'rng_meters',
                        'stats',
                    ].includes(key)
                )
            ),
        };
    }

    public async getNetworth(username: string, profileId: string): Promise<NetworthSnapshot> {
        this.assertUsername(username);
        if (!profileId || profileId.length > 100) throw new Error('The profile ID is invalid.');
        const url = new URL(
            `${encodeURIComponent(username)}?mode=main&profile=${encodeURIComponent(profileId)}`,
            new URL('networth/', this.baseUrl)
        );
        const data = await this.getJson(url);
        if (data.mode !== 'main' || stringValue(data.profile_id) !== profileId) {
            throw new Error('The networth API returned a different main profile.');
        }
        const { hidden, partial } = data;
        if (typeof hidden !== 'boolean' || typeof partial !== 'boolean') {
            throw new Error('The networth API did not return complete privacy/status fields.');
        }
        const total = numberValue(data.total);
        if (!hidden && total === undefined) {
            throw new Error('The networth API returned no usable total.');
        }
        return {
            username,
            profileId,
            total: hidden ? undefined : total,
            hidden,
            partial,
            observedAt: timestamp(data.fetched_at) ?? this.now(),
            calculatedAt: timestamp(data.calculated_at),
            marketObservedAt: timestamp(data.market_observed_at),
        };
    }

    // eslint-disable-next-line class-methods-use-this
    private assertUsername(username: string) {
        if (!USERNAME_PATTERN.test(username) || username !== username.trim()) {
            throw new Error('The player username is invalid.');
        }
    }

    private async getJson(url: URL): Promise<JsonObject> {
        if (url.protocol !== 'https:' || url.hostname !== this.baseUrl.hostname) {
            throw new Error('Leaderboard API request was outside the configured HTTPS host.');
        }
        return this.limiter.run(async () => {
            if (this.now() < this.retryAfterAt) throw new Error('Leaderboard API is rate limited.');
            let retried = false;
            while (true) {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), this.timeoutMs);
                try {
                    const response = await this.fetcher(url, {
                        method: 'GET',
                        redirect: 'error',
                        signal: controller.signal,
                        headers: { accept: 'application/json' },
                    });
                    const length = Number(response.headers.get('content-length'));
                    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
                        throw new Error('Leaderboard API response was too large.');
                    }
                    if (response.status === 429) {
                        const retryAfter = this.retryDelay(response.headers.get('retry-after'));
                        this.retryAfterAt = this.now() + retryAfter;
                        await response.body?.cancel();
                        if (retried || retryAfter > MAX_RETRY_DELAY_MS)
                            throw new Error('Leaderboard API is rate limited.');
                        retried = true;
                        clearTimeout(timer);
                        await this.sleep(retryAfter);
                        continue;
                    }
                    if (!response.ok)
                        throw new Error(`Leaderboard API returned HTTP ${response.status}.`);
                    if (!response.body) throw new Error('Leaderboard API returned no body.');
                    const reader = response.body.getReader();
                    const chunks: Uint8Array[] = [];
                    let bytes = 0;
                    // eslint-disable-next-line no-constant-condition
                    while (true) {
                        // eslint-disable-next-line no-await-in-loop
                        const { done, value } = await reader.read();
                        if (done) break;
                        bytes += value.byteLength;
                        if (bytes > MAX_RESPONSE_BYTES) {
                            // eslint-disable-next-line no-await-in-loop
                            await reader.cancel();
                            throw new Error('Leaderboard API response was too large.');
                        }
                        chunks.push(value);
                    }
                    let parsedValue: unknown;
                    try {
                        parsedValue = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    } catch {
                        throw new Error('Leaderboard API returned invalid JSON.');
                    }
                    const parsed = object(parsedValue);
                    if (!parsed) throw new Error('Leaderboard API returned invalid JSON.');
                    return parsed;
                } catch (error) {
                    if (error instanceof Error && error.name === 'AbortError') {
                        throw new Error('Leaderboard API request timed out.');
                    }
                    throw error;
                } finally {
                    clearTimeout(timer);
                }
            }
        });
    }

    private retryDelay(value: string | null) {
        if (!value) return 250;
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return seconds * 1_000;
        }
        const date = Date.parse(value);
        if (Number.isFinite(date)) return Math.max(0, date - this.now());
        return 250;
    }
}
