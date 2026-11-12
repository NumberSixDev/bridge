const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { default: AfkKeeper, isAfkWindow } = require('../dist/src/mineflayer/afk.js');

function afkWindow(time = '14:59') {
    return {
        title: {
            type: 'compound',
            value: { text: { type: 'string', value: `AFK Rewards · ${time}` } },
        },
    };
}

function harness() {
    let now = 0;
    const timers = new Map();
    const bot = new EventEmitter();
    bot.currentWindow = null;
    const state = { ready: true, reject: false, commands: [] };
    const keeper = new AfkKeeper({
        bot,
        isReady: () => state.ready,
        sendCommand: () => {
            if (state.reject) throw Error('Disconnected');
            state.commands.push(now);
        },
        now: () => now,
        setTimer: (callback, delay) => {
            const timer = { due: now + delay, callback, unref() {} };
            timers.set(timer, timer);
            return timer;
        },
        clearTimer: (timer) => timers.delete(timer),
    });
    function advance(milliseconds) {
        const end = now + milliseconds;
        while (true) {
            const next = [...timers.values()].sort((a, b) => a.due - b.due)[0];
            if (!next || next.due > end) break;
            now = next.due;
            timers.delete(next);
            next.callback();
        }
        now = end;
    }
    function open(window = afkWindow()) {
        bot.currentWindow = window;
        bot.emit('windowOpen', window);
    }
    function close() {
        const window = bot.currentWindow;
        bot.currentWindow = null;
        bot.emit('windowClose', window);
    }
    keeper.start();
    return { keeper, bot, state, timers, advance, open, close };
}

test('AFK menu recognition supports observed NBT and plain/JSON titles only', () => {
    for (const window of [
        afkWindow(),
        { title: 'AFK Rewards · 00:01' },
        { title: '{"text":"AFK Rewards · 15:00"}' },
        { title: { text: '§aAFK Rewards' } },
    ])
        assert.equal(isAfkWindow(window), true);
    for (const title of ['Other AFK Rewards', 'Profile Selector', '{broken', null, { text: [] }])
        assert.equal(isAfkWindow({ title }), false);
    assert.equal(isAfkWindow(null), false);
});

test('AFK starts once after settling and preserves an open reward timer indefinitely', () => {
    const h = harness();
    h.keeper.start();
    h.advance(1_999);
    assert.deepEqual(h.state.commands, []);
    h.advance(1);
    assert.deepEqual(h.state.commands, [2_000]);
    h.open();
    h.advance(60 * 60_000);
    assert.equal(h.keeper.isActive, true);
    assert.deepEqual(h.state.commands, [2_000]);
    h.keeper.stop();
    assert.equal(h.timers.size, 0);
});

test('AFK reopens a closed menu, but does not reset timer-driven window replacements', () => {
    const h = harness();
    h.advance(2_000);
    h.open();
    for (let i = 0; i < 30; i++) {
        h.close();
        h.advance(500);
        h.open(afkWindow('14:30'));
        h.advance(500);
    }
    assert.equal(h.state.commands.length, 1);
    h.close();
    h.advance(2_000);
    assert.equal(h.state.commands.length, 2);
    h.keeper.stop();
});

test('a confirmed AFK menu can be restored promptly without an unsuccessful-retry delay', () => {
    const h = harness();
    h.advance(2_000);
    h.open();
    h.close();
    h.advance(2_000);
    assert.deepEqual(h.state.commands, [2_000, 4_000]);
    h.keeper.stop();
});

test('AFK waits through lobby transfer then re-enters even if the old window remains', () => {
    const h = harness();
    h.advance(2_000);
    h.open();
    h.bot.emit('respawn');
    h.advance(30_000);
    assert.equal(h.state.commands.length, 1);
    assert.equal(h.keeper.isActive, false);
    h.bot.emit('spawn');
    h.bot.emit('spawn');
    h.advance(2_000);
    assert.equal(h.state.commands.length, 2);
    h.open();
    assert.equal(h.keeper.isActive, true);
    h.keeper.stop();
});

test('AFK watchdog recovers a silently missing window and bounds unsuccessful retries', () => {
    const h = harness();
    h.advance(2_000);
    h.open();
    h.advance(30_000);
    h.bot.currentWindow = null;
    h.advance(10_000);
    assert.equal(h.state.commands.length, 2);
    for (let i = 0; i < 100; i++) h.bot.emit('windowClose');
    h.advance(30_000);
    assert.ok(
        h.state.commands.every((time, index, times) => !index || time - times[index - 1] >= 15_000)
    );
    h.keeper.stop();
});

test('AFK sends nothing while unready, recovers errors, and stops all old-client callbacks', () => {
    const h = harness();
    h.state.ready = false;
    h.advance(60_000);
    assert.deepEqual(h.state.commands, []);
    h.state.ready = true;
    h.state.reject = true;
    h.advance(10_000);
    assert.deepEqual(h.state.commands, []);
    h.state.reject = false;
    h.advance(15_000);
    assert.equal(h.state.commands.length, 1);
    h.keeper.stop();
    h.bot.emit('spawn');
    h.close();
    h.advance(60_000);
    assert.equal(h.state.commands.length, 1);
    assert.equal(h.timers.size, 0);
    assert.equal(h.bot.listenerCount('spawn'), 0);
    assert.equal(h.bot.listenerCount('windowClose'), 0);
});
