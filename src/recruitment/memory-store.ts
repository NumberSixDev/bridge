import { createDefaultRecruitmentState, RecruitmentState, RecruitmentStore } from './types';

export default class MemoryRecruitmentStore implements RecruitmentStore {
    constructor(private value = createDefaultRecruitmentState()) {}

    public load() {
        return structuredClone(this.value);
    }

    public async save(value: RecruitmentState) {
        this.value = structuredClone(value);
    }

    public snapshot() {
        return structuredClone(this.value);
    }
}
