const fs = require('fs');
const path = require('path');
// The output path is fixed inside this checkout.
fs.rmSync(path.resolve(__dirname, '..', 'dist'), { recursive: true, force: true });
