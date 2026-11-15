import test from 'node:test';
import assert from 'node:assert/strict';
import storageEvents from '../../chat/services/storageEvents.js';

test('a closed channel cannot break immediate or delayed storage notifications', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const events = new storageEvents.constructor();
    events.channel = new BroadcastChannel('oa-storage-notification-test');
    events.channel.close();
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args));
    assert.doesNotThrow(() => events.broadcast('sessions-updated', { sessionId: 'test-chat' }));
    events.broadcastDebounced('messages-updated', 'test-chat', { sessionId: 'test-chat' }, 500);
    assert.doesNotThrow(() => t.mock.timers.tick(500));
    assert.equal(events.debounceTimers.size, 0);
    assert.deepEqual(warnings, [
        ['Cross-tab storage notification unavailable.'],
        ['Cross-tab storage notification unavailable.']
    ], 'diagnostics must not contain the message, session ID or payload');
});

test('working channels still coalesce notices and can notify again after the timer', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const events = new storageEvents.constructor();
    const sent = [];
    events.channel = { postMessage: message => sent.push(message) };
    events.broadcastDebounced('messages-updated', 'test-chat', { sessionId: 'test-chat' }, 500);
    events.broadcastDebounced('messages-updated', 'test-chat', { sessionId: 'test-chat' }, 500);
    t.mock.timers.tick(499);
    assert.equal(sent.length, 0);
    t.mock.timers.tick(1);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].payload, { sessionId: 'test-chat' });
    events.broadcastDebounced('messages-updated', 'test-chat', { sessionId: 'test-chat' }, 500);
    t.mock.timers.tick(500);
    assert.equal(sent.length, 2);
});
