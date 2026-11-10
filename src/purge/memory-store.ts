import { PurgeExclusionStore } from './types';
import { validateUsernames } from './store';

export default class MemoryPurgeStore implements PurgeExclusionStore {
    private value: string[];

    public constructor(initial: string[] = []) {
        this.value = validateUsernames(initial);
    }

    public load(_guildId: string) {
        return [...this.value];
    }

    public async save(_guildId: string, usernames: string[]) {
        this.value = validateUsernames(usernames);
    }

    public snapshot() {
        return [...this.value];
    }
}
