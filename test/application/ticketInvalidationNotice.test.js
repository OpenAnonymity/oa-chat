import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the real event registration without booting the app or a wallet.
const source = fs.readFileSync('chat/app.js', 'utf8');
const registration = source.match(/window\.addEventListener\('ticket-key-invalidated', \(event\) => \{[\s\S]*?\n        \}\);/)[0];
function fixture() {
    let listener;
    const notices = [];
    vm.runInNewContext(registration, {
        window: { addEventListener: (type, callback) => { assert.equal(type, 'ticket-key-invalidated'); listener = callback; } },
        showToast: (...args) => notices.push(args)
    });
    return { listener, notices };
}

test('confirmed invalidation uses neutral accurate copy, without claiming a month or spent count', () => {
    const { listener, notices } = fixture();
    listener({ detail: { removedCount: 23 } });
    assert.deepEqual(notices, [['Unused tickets are no longer valid.', 'info', 5000]]);
});

test('empty, duplicate zero-removal and malformed invalidations remain silent', () => {
    const { listener, notices } = fixture();
    for (const removedCount of [0, -1, NaN, Infinity, 1.5, undefined]) listener({ detail: { removedCount } });
    listener({});
    assert.deepEqual(notices, []);
});
