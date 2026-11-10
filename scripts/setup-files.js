/* eslint-disable no-console */
const fs = require('fs');

if (fs.existsSync('.env')) {
    console.info("'.env' already exists; existing settings were preserved.");
} else {
    fs.copyFileSync('.env.template', '.env', fs.constants.COPYFILE_EXCL);
    console.info("Created '.env'. Add the account, token and Discord IDs before starting.");
}
