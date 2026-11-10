/* eslint-disable no-console */
const { config } = require('dotenv');
// The compiled path is created by the build immediately before this script runs.
// eslint-disable-next-line import/no-unresolved, import/extensions
const { envSchema } = require('../dist/src/util/config');

config({ quiet: true });
const result = envSchema.safeParse(process.env);
if (!result.success) {
    console.error('Configuration is not ready:');
    result.error.issues.forEach((issue) => {
        console.error(`- ${issue.path.join('.')}: ${issue.message}`);
    });
    process.exitCode = 1;
} else {
    console.info('Configuration is valid. No accounts were connected.');
}
