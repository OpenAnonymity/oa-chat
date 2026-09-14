import test from 'node:test';
import assert from 'node:assert/strict';
import { infoTooltipPosition } from '../../chat/components/InfoTooltips.js';

test('both payment labels clear the whole switch and System Panel on its right', () => {
    const rect = { left: 750, right: 820, top: 12, bottom: 44 };
    for (const width of [200, 240]) {
        const position = infoTooltipPosition(rect, width, 36, { width: 1100, height: 700 }, true);
        assert.equal(position.left + width, rect.left - 8);
        assert.equal(position.top, 12);
    }
});

test('narrow screens place the label below the switch and keep it in the viewport', () => {
    assert.deepEqual(infoTooltipPosition({ left: 230, right: 300, top: 12, bottom: 44 },
        270, 36, { width: 320, height: 640 }, true), { left: 30, top: 52 });
});

test('settings descriptions keep their existing below/above placement', () => {
    assert.deepEqual(infoTooltipPosition({ left: 100, right: 124, top: 580, bottom: 604 },
        200, 60, { width: 400, height: 640 }), { left: 100, top: 512 });
});
