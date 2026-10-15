import test from 'node:test';
import assert from 'node:assert/strict';
import { placeSessionMenu } from '../../chat/components/Sidebar.js';

const viewport = { width: 1280, height: 800 };
const size = { width: 175, height: 290 };
const button = top => ({ top, bottom: top + 36, left: 180, right: 216 });

test('a row menu opens below its button when it fits', () => {
    const place = placeSessionMenu(button(100), size, viewport);
    assert.equal(place.side, 'bottom');
    assert.equal(place.top, 140);
    assert.equal(place.left, 216 - 175);
    assert.equal(place.maxHeight, null);
});

test('a row menu near the bottom flips above its button', () => {
    const place = placeSessionMenu(button(640), size, viewport);
    assert.equal(place.side, 'top');
    assert.equal(place.top, 640 - 4 - 290);
    assert.equal(place.maxHeight, null);
});

test('it stays below while it still fits, even close to the edge', () => {
    // 800 - 8 margin - 4 gap - 290 = 498 is the lowest button bottom that fits.
    assert.equal(placeSessionMenu({ top: 462, bottom: 498, right: 216 }, size, viewport).side, 'bottom');
    assert.equal(placeSessionMenu({ top: 463, bottom: 499, right: 216 }, size, viewport).side, 'top');
});

test('a window too short for either side uses the roomier side and scrolls', () => {
    const short = { width: 1280, height: 320 };
    const place = placeSessionMenu(button(200), size, short);
    assert.equal(place.side, 'top');
    assert.equal(place.maxHeight, 200 - 4 - 8);
    assert.equal(place.top, 8);
});

test('the menu never runs off the left or right edge', () => {
    assert.equal(placeSessionMenu({ top: 100, bottom: 136, right: 60 }, size, viewport).left, 8);
    assert.equal(placeSessionMenu({ top: 100, bottom: 136, right: 1400 }, size, viewport).left, 1280 - 8 - 175);
});
