import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { z } from 'zod';
import { createDefaultRecruitmentState, RecruitmentState, RecruitmentStore } from './types';

const money = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const decision = z.object({
    kind: z.enum(['manual-accept', 'automatic-accept', 'deny']),
    actorId: z.string().min(1).max(100).optional(),
    decidedAt: z.number().finite(),
    note: z.string().max(500).optional(),
});
const application = z.object({
    id: z.string().min(1).max(100),
    username: z.string().regex(/^[A-Za-z0-9_]{1,16}$/),
    usernameKey: z.string().regex(/^[a-z0-9_]{1,16}$/),
    receivedAt: z.number().finite(),
    status: z.enum(['pending', 'accepting', 'acceptance-sent', 'denied', 'needs-verification']),
    lookupStatus: z.enum(['pending', 'complete', 'manual', 'error']),
    playerUuid: z.string().max(100).optional(),
    profileId: z.string().max(100).optional(),
    profileName: z.string().max(100).optional(),
    profileSavedAt: z.number().finite().optional(),
    calculatedAt: z.number().finite().optional(),
    marketObservedAt: z.number().finite().optional(),
    purse: money.optional(),
    networth: money.optional(),
    partial: z.boolean().optional(),
    hidden: z.boolean().optional(),
    unpriced: z.number().finite().nonnegative().optional(),
    uncertainValue: money.optional(),
    coverageIssues: z.array(z.string().max(300)).max(30),
    evaluationReason: z.string().max(1000).optional(),
    deliveryIssue: z.string().max(500).optional(),
    decision: decision.optional(),
    thresholdNetworth: money.optional(),
    thresholdPurse: money.optional(),
    thresholdAutoEnabled: z.boolean(),
    autoCandidate: z.boolean(),
    settingsRevision: z.number().int().nonnegative().optional(),
    channelId: z
        .string()
        .regex(/^\d{17,20}$/)
        .optional(),
    messageId: z
        .string()
        .regex(/^\d{17,20}$/)
        .optional(),
});
const state = z
    .object({
        version: z.literal(1),
        settings: z.object({
            autoAcceptEnabled: z.boolean(),
            revision: z.number().int().nonnegative().optional(),
            minimumNetworth: money.optional(),
            minimumPurse: money.optional(),
            panelMessageId: z
                .string()
                .regex(/^\d{17,20}$/)
                .optional(),
            panelChannelId: z
                .string()
                .regex(/^\d{17,20}$/)
                .optional(),
        }),
        applications: z.array(application).max(1000),
    })
    .refine(
        (value) =>
            !value.settings.autoAcceptEnabled ||
            (value.settings.minimumNetworth !== undefined &&
                value.settings.minimumPurse !== undefined),
        'Automatic acceptance cannot be enabled without both minimums.'
    );

// eslint-disable-next-line import/prefer-default-export
export class FileRecruitmentStore implements RecruitmentStore {
    constructor(private readonly filePath: string) {}

    public load(): RecruitmentState {
        try {
            const raw = fsSync.readFileSync(this.filePath, 'utf8');
            const parsed = state.safeParse(JSON.parse(raw));
            if (!parsed.success) throw new Error('Recruitment data failed schema validation.');
            return parsed.data;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return createDefaultRecruitmentState();
            throw error;
        }
    }

    public async save(value: RecruitmentState) {
        const parsed = state.safeParse(value);
        if (!parsed.success) throw new Error('Recruitment data failed schema validation.');
        const directory = path.dirname(this.filePath);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.chmod(directory, 0o700);
        const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
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
