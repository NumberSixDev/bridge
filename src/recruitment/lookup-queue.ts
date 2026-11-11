import { LookupEvidence } from './types';

interface LookupTask {
    key: string;
    username: string;
    resolve: (evidence: LookupEvidence) => void;
    reject: (error: unknown) => void;
}

export default class LookupQueue {
    private active = 0;
    private readonly queue: LookupTask[] = [];
    private readonly inflight = new Map<string, Promise<LookupEvidence>>();

    constructor(private readonly run: (username: string) => Promise<LookupEvidence>) {}

    public lookup(username: string): Promise<LookupEvidence> {
        if (!/^[A-Za-z0-9_]{1,16}$/.test(username))
            return Promise.reject(new Error('The lookup username is not valid.'));
        const key = username.toLowerCase();
        let request = this.inflight.get(key);
        if (!request) {
            request = new Promise<LookupEvidence>((resolve, reject) => {
                this.queue.push({ key, username, resolve, reject });
            });
            this.inflight.set(key, request);
            this.drain();
        }
        // Share only work still in progress, never a completed or failed result.
        // Each caller gets its own evidence object for independent decisions.
        return request.then((evidence) => structuredClone(evidence));
    }

    private drain() {
        while (this.active < 2 && this.queue.length) {
            const task = this.queue.shift()!;
            this.active += 1;
            Promise.resolve()
                .then(() => this.run(task.username))
                .then(
                    (evidence) => {
                        this.finish(task);
                        task.resolve(evidence);
                    },
                    (error: unknown) => {
                        this.finish(task);
                        task.reject(error);
                    }
                );
        }
    }

    private finish(task: LookupTask) {
        this.inflight.delete(task.key);
        this.active -= 1;
        this.drain();
    }
}
