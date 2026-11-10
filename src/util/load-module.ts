import { createRequire } from 'module';

// The build is CommonJS. require supports native Windows/macOS paths and
// avoids the extra default-export wrapper introduced by dynamic import().
const requireModule = createRequire(__filename);
export default function loadModule<T>(filename: string): T {
    return (requireModule(filename) as { default: T }).default;
}
