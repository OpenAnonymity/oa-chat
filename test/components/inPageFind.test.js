import test from 'node:test';
import assert from 'node:assert/strict';
import {
    FindIdleTimer,
    IN_PAGE_FIND_IDLE_TIMEOUT_MS,
    chooseActiveDialog,
    findCaseInsensitiveMatchOffsets,
    getNextFindMatchIndex
} from '../../chat/components/InPageFind.js';

test('find navigation wraps in both directions', () => {
    assert.equal(getNextFindMatchIndex(-1, 3, 1), 0);
    assert.equal(getNextFindMatchIndex(2, 3, 1), 0);
    assert.equal(getNextFindMatchIndex(0, 3, -1), 2);
    assert.equal(getNextFindMatchIndex(0, 0, 1), -1);
});

test('find inactivity expires after the fixed timeout', () => {
    let now = 1_000;
    let scheduled = null;
    let expired = 0;
    const timer = new FindIdleTimer({
        now: () => now,
        setTimeoutFn: (callback, delay) => {
            scheduled = { callback, delay };
            return 1;
        },
        clearTimeoutFn: () => {},
        onExpire: () => { expired += 1; }
    });

    timer.touch();
    assert.equal(scheduled.delay, IN_PAGE_FIND_IDLE_TIMEOUT_MS);

    now += IN_PAGE_FIND_IDLE_TIMEOUT_MS - 1;
    scheduled.callback();
    assert.equal(expired, 0);
    assert.equal(scheduled.delay, 1);

    now += 1;
    scheduled.callback();
    assert.equal(expired, 1);
    assert.equal(timer.deadline, 0);
});

test('find activity resets the inactivity deadline', () => {
    let now = 0;
    let scheduled = null;
    const timer = new FindIdleTimer({
        now: () => now,
        setTimeoutFn: (callback, delay) => {
            scheduled = { callback, delay };
            return 1;
        },
        clearTimeoutFn: () => {}
    });

    timer.touch();
    now = 6_000;
    timer.touch();
    assert.equal(timer.deadline, 16_000);
    assert.equal(scheduled.delay, IN_PAGE_FIND_IDLE_TIMEOUT_MS);
});

test('find matching returns original-string offsets for Unicode case folding', () => {
    assert.deepEqual(findCaseInsensitiveMatchOffsets('İstanbul iSTANBUL', 'istanbul'), [
        { start: 9, end: 17 }
    ]);
    assert.deepEqual(findCaseInsensitiveMatchOffsets('OPEN anonymity', 'open'), [
        { start: 0, end: 4 }
    ]);
});

test('find matching reports offsets that can span adjacent text segments', () => {
    const text = ['and ', 'provably', ' unlinkable'].join('');
    assert.deepEqual(findCaseInsensitiveMatchOffsets(text, 'and provably'), [
        { start: 0, end: 12 }
    ]);
});

test('find focus recovery prioritizes a true modal over later non-modal dialogs', () => {
    const modal = { matches: (selector) => selector.includes('aria-modal') };
    const laterQuickAsk = { matches: () => false };
    assert.equal(chooseActiveDialog([modal, laterQuickAsk]), modal);
    assert.equal(chooseActiveDialog([laterQuickAsk]), laterQuickAsk);
    assert.equal(chooseActiveDialog([]), null);
});
