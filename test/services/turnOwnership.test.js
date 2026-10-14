import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    holdTurn, probeTurnOwnership, whenTurnReleased, turnLockName,
    OWNERSHIP_ELSEWHERE, OWNERSHIP_NONE, OWNERSHIP_UNKNOWN
} from '../../chat/services/turnOwnership.js';

// A small Web Locks stand-in with the semantics the module relies on: one
// exclusive holder or any number of shared holders per name, FIFO queueing,
// ifAvailable (callback gets null instead of waiting) and abortable waits.
function fakeLockManager() {
    const names = new Map(); // name -> { holders: [{mode}], queue: [...] }
    const entry = name => {
        if (!names.has(name)) names.set(name, { holders: [], queue: [] });
        return names.get(name);
    };
    const grantable = (state, mode) => state.holders.length === 0
        || (mode === 'shared' && state.holders.every(holder => holder.mode === 'shared'));
    const settle = name => {
        const state = entry(name);
        while (state.queue.length && grantable(state, state.queue[0].mode)) {
            const next = state.queue.shift();
            grant(name, next);
        }
    };
    const grant = (name, { mode, callback, resolve, reject }) => {
        const state = entry(name);
        const holder = { mode };
        state.holders.push(holder);
        Promise.resolve().then(() => callback({ name, mode })).then(resolve, reject).finally(() => {
            state.holders.splice(state.holders.indexOf(holder), 1);
            settle(name);
        });
    };
    return {
        request(name, options, callback) {
            const mode = options.mode || 'exclusive';
            const state = entry(name);
            return new Promise((resolve, reject) => {
                if (grantable(state, mode) && state.queue.length === 0) return grant(name, { mode, callback, resolve, reject });
                if (options.ifAvailable) return Promise.resolve().then(() => callback(null)).then(resolve, reject);
                const pending = { mode, callback, resolve, reject };
                state.queue.push(pending);
                options.signal?.addEventListener('abort', () => {
                    const at = state.queue.indexOf(pending);
                    if (at === -1) return;
                    state.queue.splice(at, 1);
                    reject(new DOMException('Aborted', 'AbortError'));
                });
            });
        },
        held(name) { return entry(name).holders.map(holder => holder.mode); }
    };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('turn ownership across tabs', () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    let locks;
    beforeEach(() => {
        locks = fakeLockManager();
        Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { locks } });
    });
    afterEach(() => {
        if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
        else delete globalThis.navigator;
    });

    test('a held turn reads as answering elsewhere until it is released, then as nobody\'s', async () => {
        assert.equal(await probeTurnOwnership('chat'), OWNERSHIP_NONE);
        const release = holdTurn('chat');
        await tick();
        assert.deepEqual(locks.held(turnLockName('chat')), ['exclusive']);
        assert.equal(await probeTurnOwnership('chat'), OWNERSHIP_ELSEWHERE);
        assert.equal(await probeTurnOwnership('other-chat'), OWNERSHIP_NONE, 'the lock is per chat');

        let released = false;
        const waiting = whenTurnReleased('chat').then(value => { released = value; });
        await tick();
        assert.equal(released, false, 'the wait outlives the turn');
        release();
        await waiting;
        assert.equal(released, true);
        await tick();
        assert.deepEqual(locks.held(turnLockName('chat')), []);
        assert.equal(await probeTurnOwnership('chat'), OWNERSHIP_NONE);
    });

    test('holding never waits: a turn already held elsewhere is simply not held here', async () => {
        const first = holdTurn('chat');
        await tick();
        const second = holdTurn('chat');
        await tick();
        assert.deepEqual(locks.held(turnLockName('chat')), ['exclusive'], 'no second holder, no queue');
        second();
        await tick();
        assert.equal(await probeTurnOwnership('chat'), OWNERSHIP_ELSEWHERE, 'the no-op release leaves the real holder alone');
        first();
        await tick();
        assert.equal(await probeTurnOwnership('chat'), OWNERSHIP_NONE);
    });

    test('a release wait can be abandoned, and resolves at once when nobody holds the turn', async () => {
        assert.equal(await whenTurnReleased('chat'), true);
        const release = holdTurn('chat');
        await tick();
        const abort = new AbortController();
        const waiting = whenTurnReleased('chat', abort.signal);
        await tick();
        abort.abort();
        assert.equal(await waiting, false);
        release();
        await tick();
        assert.equal(await whenTurnReleased('chat', AbortSignal.abort()), false, 'an aborted signal never waits');
    });

    test('without Web Locks nothing is held and ownership is unknown', async () => {
        Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: {} });
        assert.equal(typeof holdTurn('chat'), 'function');
        assert.equal(await probeTurnOwnership('chat'), OWNERSHIP_UNKNOWN);
        assert.equal(await whenTurnReleased('chat'), false);
        assert.equal(await probeTurnOwnership(''), OWNERSHIP_UNKNOWN, 'no session, nothing to ask');
    });
});
