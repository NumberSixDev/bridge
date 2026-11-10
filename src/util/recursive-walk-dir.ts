import fs from 'fs/promises';
import path from 'path';

export default async function recursiveWalkDir(
    dir: string,
    callback: (currentDir: string, file: string) => Promise<void>,
    errorMessage: string
) {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        await Promise.all(
            entries.map((entry) =>
                entry.isDirectory()
                    ? recursiveWalkDir(path.join(dir, entry.name), callback, errorMessage)
                    : callback(dir, entry.name)
            )
        );
    } catch (error) {
        throw new Error(errorMessage, { cause: error });
    }
}
