/* eslint-disable no-restricted-syntax */
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { PurgeExclusionStore } from './types';

const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,16}$/;
const MAX_EXCLUSIONS = 500;
const state = z
    .object({
        version: z.literal(1),
        guildId: z.string().regex(/^\d{17,20}$/),
        excluded: z.array(z.string().regex(USERNAME_PATTERN)).max(MAX_EXCLUSIONS),
        updatedAt: z.number().finite(),
    })
    .superRefine((value, context) => {
        const keys = new Set<string>();
        for (const username of value.excluded) {
            const key = username.toLowerCase();
            if (keys.has(key)) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'Purge exclusions contain duplicate usernames.',
                });
                return;
            }
            keys.add(key);
        }
    });

function normalise(usernames: string[]) {
    return [...new Map(usernames.map((username) => [username.toLowerCase(), username])).values()]
        .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()))
        .map((username) => username.toLowerCase());
}

export function validateUsernames(usernames: string[]) {
    if (usernames.length > MAX_EXCLUSIONS) throw new Error('Too many purge exclusions.');
    const normalised = normalise(usernames);
    if (normalised.length !== usernames.length)
        throw new Error('Purge exclusions contain duplicate usernames.');
    if (!normalised.every((username) => USERNAME_PATTERN.test(username)))
        throw new Error('Purge exclusions contain an invalid Minecraft username.');
    return normalised;
}

export class FilePurgeStore implements PurgeExclusionStore {
    public constructor(private readonly filePath: string, private readonly now = Date.now) {}

    public load(guildId: string) {
        try {
            if (fsSync.statSync(this.filePath).size > 100_000)
                throw new Error('Purge exclusion file is too large.');
            const parsed = state.safeParse(JSON.parse(fsSync.readFileSync(this.filePath, 'utf8')));
            if (!parsed.success) throw new Error('Purge exclusion data failed schema validation.');
            if (parsed.data.guildId !== guildId)
                throw new Error('Purge exclusion data belongs to a different Discord guild.');
            return validateUsernames(parsed.data.excluded);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        }
    }

    public async save(guildId: string, usernames: string[]) {
        const excluded = validateUsernames(usernames);
        const parsed = state.safeParse({
            version: 1,
            guildId,
            excluded,
            updatedAt: this.now(),
        });
        if (!parsed.success) throw new Error('Purge exclusion data failed schema validation.');
        const directory = path.dirname(this.filePath);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.chmod(directory, 0o700);
        const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
        try {
            await fs.writeFile(temporary, `${JSON.stringify(parsed.data, null, 2)}\n`, {
                encoding: 'utf8',
                mode: 0o600,
            });
            await fs.chmod(temporary, 0o600);
            await fs.rename(temporary, this.filePath);
            await fs.chmod(this.filePath, 0o600);
        } catch (error) {
            await fs.unlink(temporary).catch(() => undefined);
            throw error;
        }
    }
}
