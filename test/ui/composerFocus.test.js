import test from 'node:test';
import assert from 'node:assert/strict';
import { dismissSubmittedPhoneKeyboard, promptReadingOffset } from '../../chat/ui/composerFocus.js';

test('accepted empty phone composer blurs, but a newer draft, another control and desktop retain focus', () => {
    let blurs = 0;
    const doc = { defaultView: { innerWidth: 390 } };
    const input = { ownerDocument: doc, value: '', blur() { blurs++; } };
    doc.activeElement = input;
    dismissSubmittedPhoneKeyboard(input); assert.equal(blurs, 1);
    input.value = 'Next draft'; dismissSubmittedPhoneKeyboard(input);
    input.value = ''; doc.activeElement = {}; dismissSubmittedPhoneKeyboard(input);
    doc.activeElement = input; doc.defaultView.innerWidth = 1200; dismissSubmittedPhoneKeyboard(input);
    assert.equal(blurs, 1);
});

test('phone image prompt leaves room for a reply while desktop keeps its anchor', () => {
    const photo = { phone: true, areaHeight: 420, visibleHeight: 230, promptHeight: 120 };
    const offset = promptReadingOffset(photo);
    assert.ok(offset + photo.promptHeight + 96 <= photo.visibleHeight);
    assert.equal(promptReadingOffset({ ...photo, promptHeight: 500 }), -398);
    assert.equal(promptReadingOffset({ ...photo, phone: false }), 105);
});


test('HTML does not bypass phone focus policy before app startup', async () => {
    const { readFile } = await import('node:fs/promises');
    const html = await readFile('chat/index.html', 'utf8');
    const input = html.match(/<textarea[^>]*id="message-input"[^>]*>/s)?.[0];
    assert.ok(input);
    assert.doesNotMatch(input, /autofocus/);
});
