const { test } = require('node:test');
const assert = require('node:assert/strict');
const LookupQueue = require('../dist/src/recruitment/lookup-queue').default;

function evidence(username) {
    return { username, identityVerified: true, coverageIssues: [], profileSavedAt: 123 };
}

test('lookup queue coalesces case-insensitive duplicates and caps distinct concurrent lookups at two', async () => {
    const started = [];
    const releases = new Map();
    let active = 0;
    let peak = 0;
    const queue = new LookupQueue(async (username) => {
        started.push(username);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => releases.set(username, resolve));
        active--;
        return evidence(username);
    });
    const one = queue.lookup('One');
    const duplicate = queue.lookup('ONE');
    const two = queue.lookup('Two');
    const three = queue.lookup('Three');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ['One', 'Two']);
    releases.get('One')();
    const [firstResult, duplicateResult] = await Promise.all([one, duplicate]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ['One', 'Two', 'Three']);
    firstResult.coverageIssues.push('Changed by one consumer');
    assert.deepEqual(duplicateResult.coverageIssues, []);
    assert.equal(duplicateResult.profileSavedAt, 123);
    releases.get('Two')();
    releases.get('Three')();
    await Promise.all([two, three]);
    assert.equal(peak, 2);
    assert.equal(active, 0);
});

test('completed and failed evidence is never cached, and failures do not block queued work', async () => {
    let calls = 0;
    const queue = new LookupQueue(async (username) => {
        calls++;
        if (calls === 1) throw Error('Temporary API failure');
        return evidence(username);
    });
    const failed = await Promise.allSettled([queue.lookup('One'), queue.lookup('ONE')]);
    assert.equal(calls, 1);
    assert.ok(failed.every((result) => result.status === 'rejected'));
    const retried = await queue.lookup('One');
    assert.equal(retried.username, 'One');
    await queue.lookup('One');
    assert.equal(calls, 3, 'each subsequent check fetches new evidence');
    await Promise.all(['Two', 'Three', 'Four', 'Five'].map((name) => queue.lookup(name)));
    assert.equal(calls, 7);
});

test('invalid usernames and synchronous API failures release safely without making extra requests', async () => {
    let calls = 0;
    const queue = new LookupQueue((username) => {
        calls++;
        if (username === 'Broken') throw Error('Synchronous API failure');
        return Promise.resolve(evidence(username));
    });
    for (const username of ['', '../name', 'Name\n', 'abcdefghijklmnopq']) {
        await assert.rejects(queue.lookup(username), /username/);
    }
    assert.equal(calls, 0);
    const results = await Promise.allSettled(
        ['Broken', 'Valid', 'Next'].map((name) => queue.lookup(name))
    );
    assert.deepEqual(
        results.map((result) => result.status),
        ['rejected', 'fulfilled', 'fulfilled']
    );
    assert.equal(calls, 3);
});
