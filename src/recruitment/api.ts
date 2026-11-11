import env from '@util/env';
import withTimeout from '@util/with-timeout';
import { LookupClient, LookupEvidence } from './types';

const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,16}$/;
const MAX_RESPONSE_BYTES = 6_000_000;
const REQUEST_TIMEOUT_MS = 8_000;

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

// eslint-disable-next-line import/prefer-default-export
export class DragSimLookupClient implements LookupClient {
    private readonly baseUrl: URL;
    private readonly fetcher: typeof fetch;
    private readonly timeoutMs: number;

    constructor(options: { baseUrl?: string; fetcher?: typeof fetch; timeoutMs?: number } = {}) {
        const baseUrl = new URL(options.baseUrl ?? env.RECRUITMENT_API_BASE_URL);
        if (baseUrl.protocol !== 'https:') throw new Error('Recruitment API must use HTTPS.');
        if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
        this.baseUrl = baseUrl;
        this.fetcher = options.fetcher ?? fetch;
        this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    }

    public async lookup(username: string): Promise<LookupEvidence> {
        if (!USERNAME_PATTERN.test(username) || username !== username.trim()) {
            throw new Error('The application username is not valid.');
        }
        const profileUrl = new URL(
            `player/${encodeURIComponent(username)}?mode=main`,
            this.baseUrl
        );
        const profileData = await this.getJson(profileUrl);
        const player = object(profileData.player);
        const returnedUsername = stringValue(player?.player) ?? stringValue(profileData.username);
        if (!returnedUsername || returnedUsername.toLowerCase() !== username.toLowerCase()) {
            throw new Error('The profile API returned a different player identity.');
        }
        const profiles = Array.isArray(profileData.profiles)
            ? profileData.profiles
                  .map(object)
                  .filter((value): value is JsonObject => value !== undefined)
            : [];
        const selected = object(profileData.profile);
        const profileId = stringValue(selected?.id);
        if (
            !profileId ||
            profileId.length > 100 ||
            !profiles.some((profile) => stringValue(profile.id) === profileId)
        ) {
            throw new Error('The profile API did not return a matching selected profile.');
        }
        const profileName = (
            stringValue(selected?.name) ?? stringValue(selected?.profile_name)
        )?.slice(0, 100);
        const playerUuid = stringValue(player?.uuid);
        if (playerUuid && playerUuid.length > 100) throw new Error('Player identity is malformed.');
        const purse = numberValue(selected?.coins);
        const profileSavedAt = timestamp(selected?.updated_at);

        const networthUrl = new URL(
            `${encodeURIComponent(username)}?mode=main&profile=${encodeURIComponent(profileId)}`,
            new URL('networth/', this.baseUrl)
        );
        const networthData = await this.getJson(networthUrl);
        const returnedProfileId = stringValue(networthData.profile_id);
        if (returnedProfileId !== profileId) {
            throw new Error('The networth API returned a different profile.');
        }

        const coverageIssues: string[] = [];
        if (!playerUuid) coverageIssues.push('Player UUID is missing.');
        if (profileData.mode !== 'main' || networthData.mode !== 'main')
            coverageIssues.push('Main profile mode could not be verified.');
        const selectedEntry = profiles.find((profile) => profile.id === profileId);
        if (selectedEntry?.selected !== true || selected?.profile_mode !== 'NORMAL')
            coverageIssues.push('The selected main profile could not be verified.');
        if (typeof selected?.inventory_hidden !== 'boolean')
            coverageIssues.push('Profile privacy status is missing.');
        else if (selected.inventory_hidden)
            coverageIssues.push('The profile inventory is private.');
        const networthSavedAt = timestamp(networthData.profile_saved_at);
        if (profileSavedAt === undefined || networthSavedAt === undefined)
            coverageIssues.push('Profile save timestamps are missing.');
        if (purse === undefined) coverageIssues.push('Purse value is missing from the profile.');
        if (typeof networthData.hidden !== 'boolean')
            coverageIssues.push('Private status is missing.');
        else if (networthData.hidden) coverageIssues.push('The valuation is private.');
        if (typeof networthData.partial !== 'boolean')
            coverageIssues.push('Partial status is missing.');
        else if (networthData.partial) coverageIssues.push('The valuation is partial.');
        const unpriced = numberValue(networthData.unpriced);
        const uncertainValue = numberValue(networthData.uncertain_value);
        const networth = numberValue(networthData.total);
        if (networth === undefined) coverageIssues.push('Estimated networth is missing.');
        if (unpriced === undefined) coverageIssues.push('Unpriced item coverage is missing.');
        if (uncertainValue === undefined)
            coverageIssues.push('Uncertain value coverage is missing.');

        return {
            username,
            playerUuid,
            profileId,
            profileName,
            profileSavedAt:
                profileSavedAt !== undefined && networthSavedAt !== undefined
                    ? Math.min(profileSavedAt, networthSavedAt)
                    : undefined,
            calculatedAt: timestamp(networthData.calculated_at),
            marketObservedAt: timestamp(networthData.market_observed_at),
            purse,
            networth,
            partial: networthData.partial === true,
            hidden: selected?.inventory_hidden === true || networthData.hidden === true,
            unpriced,
            uncertainValue,
            identityVerified: true,
            coverageIssues,
        };
    }

    private async getJson(url: URL): Promise<JsonObject> {
        if (url.protocol !== 'https:' || url.hostname !== this.baseUrl.hostname) {
            throw new Error('Recruitment API request was outside the configured HTTPS host.');
        }
        const controller = new AbortController();
        return withTimeout(
            this.fetchJson(url, controller),
            this.timeoutMs,
            'Recruitment API request timed out.',
            () => controller.abort()
        );
    }

    private async fetchJson(url: URL, controller: AbortController): Promise<JsonObject> {
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
                throw new Error('Recruitment API response was too large.');
            }
            if (!response.ok) throw new Error(`Recruitment API returned HTTP ${response.status}.`);
            if (!response.body) throw new Error('Recruitment API returned no body.');
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let bytes = 0;
            // Streaming sequentially enforces the size bound before buffering an oversized body.
            // eslint-disable-next-line no-constant-condition
            while (true) {
                // eslint-disable-next-line no-await-in-loop
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > MAX_RESPONSE_BYTES) {
                    // eslint-disable-next-line no-await-in-loop
                    await reader.cancel();
                    throw new Error('Recruitment API response was too large.');
                }
                chunks.push(value);
            }
            const body = Buffer.concat(chunks).toString('utf8');
            const parsed = object(JSON.parse(body));
            if (!parsed) throw new Error('Recruitment API returned invalid JSON.');
            return parsed;
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error('Recruitment API request timed out.');
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
}
