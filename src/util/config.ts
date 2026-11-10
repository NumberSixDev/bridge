import { z } from 'zod';

const boolean = z.enum(['true', 'false']).transform((value) => value === 'true');
const snowflake = z.string().regex(/^\d{17,20}$/);
const optionalSnowflake = z.union([snowflake, z.literal('')]).default('');

// Named export is shared by the offline setup checker and tests.
// eslint-disable-next-line import/prefer-default-export
export const envSchema = z
    .object({
        MINECRAFT_EMAIL: z.string().email(),
        MINECRAFT_HOST: z.string().trim().min(1).default('dragsim.co'),
        MINECRAFT_PORT: z.coerce.number().int().min(1).max(65535).default(25565),
        MINECRAFT_VERSION: z
            .string()
            .regex(/^\d+\.\d+(?:\.\d+)?$/)
            .default('1.21.4'),
        MINECRAFT_CHAT_COMMAND: z
            .string()
            .regex(/^\/[a-zA-Z0-9_-]+(?: [a-zA-Z0-9_-]+)*$/)
            .default('/gc'),
        MINECRAFT_JOIN_COMMAND: z
            .union([
                z
                    .string()
                    .regex(/^\/[a-zA-Z0-9_-]+(?: [a-zA-Z0-9_-]+)*$/)
                    .max(256),
                z.literal(''),
            ])
            .default(''),
        MINECRAFT_CHAT_SEPARATOR: z.string().trim().min(1).max(10).default('>'),
        USE_PROFANITY_FILTER: boolean.default(true),
        USE_FIRST_WORD_OF_AUTHOR_NAME: boolean.default(false),
        GUILD_AUTO_ACCEPT_ENABLED: boolean.default(false),
        REMINDER_ENABLED: boolean.default(false),
        REMINDER_MESSAGE: z.string().default(''),
        REMINDER_FREQUENCY: z.coerce.number().int().positive().default(60),
        DISCORD_TOKEN: z.string().trim().min(1),
        DISCORD_IGNORE_PREFIX: z.string().trim().min(1).default(')'),
        DISCORD_SERVER_ID: snowflake,
        MEMBER_CHANNEL_ID: snowflake,
        BOT_OWNER_ID: optionalSnowflake,
        STAFF_ROLE_ID: optionalSnowflake,
    })
    .refine(
        (data) =>
            !data.REMINDER_ENABLED ||
            (data.REMINDER_MESSAGE.trim() !== '' &&
                data.MINECRAFT_CHAT_COMMAND.length + 1 + data.REMINDER_MESSAGE.length <= 256 &&
                !/[\r\n]/.test(data.REMINDER_MESSAGE)),
        {
            message: 'Set a single-line reminder that fits the 256-character command limit',
            path: ['REMINDER_MESSAGE'],
        }
    );
