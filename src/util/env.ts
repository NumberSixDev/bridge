import winston from 'winston';
import { config } from 'dotenv';
import { envSchema } from './config';

config({ quiet: true });
const env = envSchema.safeParse(process.env);
if (!env.success) {
    const issues = env.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    winston.error(`Invalid configuration:\n${issues.join('\n')}`);
    process.exit(1);
}
export default env.data;
