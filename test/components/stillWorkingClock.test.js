import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stillWorkingSeconds, buildStillWorkingLabel, tickStillWorkingClocks } from '../../chat/components/stillWorkingClock.js';

test('the count is whole seconds since the last text, and never below 1s', () => {
    const since = 10_000;
    assert.equal(stillWorkingSeconds(since, since + 1000), 1, 'the line appears after 1s and reads 1s');
    assert.equal(stillWorkingSeconds(since, since + 1999), 1);
    assert.equal(stillWorkingSeconds(since, since + 2000), 2);
    assert.equal(stillWorkingSeconds(since, since + 14_600), 14);
    assert.equal(stillWorkingSeconds(since, since + 200), 1, 'clock skew never shows 0s');
    assert.equal(stillWorkingSeconds(undefined), 1, 'no start time reads 1s');
});

test('the label reads "Still working · Ns" with the count hidden from screen readers', () => {
    const html = buildStillWorkingLabel(0, 3500);
    assert.match(html, /^<span class="pending-response-label pending-response-streaming">Still working<span aria-hidden="true"> · <span class="still-working-seconds">3<\/span>s<\/span><\/span>$/);
    assert.doesNotMatch(html, /…/, 'the ellipsis gives way to the count');
});

test('one tick rewrites every visible count from its own start time', () => {
    const outA = { textContent: '1' };
    const outB = { textContent: '9' };
    const line = (since, out) => ({ getAttribute: () => String(since), querySelector: () => out });
    const root = { querySelectorAll: () => [line(0, outA), line(5000, outB)] };
    assert.equal(tickStillWorkingClocks(root, 12_400), 2);
    assert.equal(outA.textContent, '12');
    assert.equal(outB.textContent, '7');
    assert.equal(tickStillWorkingClocks({ querySelectorAll: () => [] }), 0, 'no lines left: the clock can stop');
});
