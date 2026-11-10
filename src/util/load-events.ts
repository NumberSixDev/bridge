import path from 'path';
import winston from 'winston';
import regex from '@mineflayer/events/regex';
import recursiveWalkDir from '@util/recursive-walk-dir';
import loadModule from '@util/load-module';
import Bridge from '../bridge';

type EventHandler = (...args: any[]) => void;
interface EmitterLike {
    on(event: string, listener: EventHandler): void;
    once(event: string, listener: EventHandler): void;
    addChatPattern?(
        name: string,
        pattern: RegExp,
        options: { repeat: boolean; parse: boolean }
    ): void;
}

export default async function loadEvents(dir: string, emitter: EmitterLike, bridge: Bridge) {
    await recursiveWalkDir(
        dir,
        async (currentDir, file) => {
            if (!(file.endsWith('.ts') || file.endsWith('.js')) || file.endsWith('.d.ts')) return;
            const { name, runOnce, run } = loadModule<BotEvent>(path.join(currentDir, file));
            if (!name || !run) throw new Error(`Invalid event: ${file}`);
            if (name in regex && emitter.addChatPattern) {
                emitter.addChatPattern(
                    name.replace('chat:', ''),
                    regex[name as keyof typeof regex],
                    {
                        repeat: true,
                        parse: true,
                    }
                );
            }
            const listener = (...args: any[]) => {
                Promise.resolve()
                    .then(() => run(bridge, ...args.flat(2)))
                    .catch((error: unknown) => {
                        winston.error(`Event ${name} failed:`, error);
                    });
            };
            if (runOnce) emitter.once(name, listener);
            else emitter.on(name, listener);
        },
        'Error while loading events:'
    );
}
