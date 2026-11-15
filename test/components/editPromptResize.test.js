import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = relative => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

test('the edit box is sized by its height, so auto-grow and the resize corner work', () => {
    const css = read('chat/styles.css');
    // flex-1 (a 0% basis) inside the column made the box ignore its height.
    assert.match(css, /\.edit-prompt-textarea \{[^}]*flex: 0 0 auto;/s);
    const template = read('chat/components/MessageTemplates.js');
    assert.match(template, /class="edit-prompt-textarea[^"]*resize-y/);
});

test('auto-grow keeps the size the person dragged the edit box to', async () => {
    const { default: ChatArea } = await import('../../chat/components/ChatArea.js');
    const autoGrow = ChatArea.prototype.autoGrowTextarea;
    const textarea = {
        dataset: {},
        style: { overflow: '', height: '' },
        scrollHeight: 96,
        getBoundingClientRect() { return { height: parseFloat(this.style.height) || 0 }; }
    };
    autoGrow.call({}, textarea);
    assert.equal(textarea.style.height, '96px', 'grows to its content');
    assert.equal(textarea.dataset.autoHeight, '96');

    textarea.dataset.manualHeight = '240';
    autoGrow.call({}, textarea);
    assert.equal(textarea.style.height, '240px', 'typing does not shrink a box dragged taller');

    textarea.scrollHeight = 320;
    autoGrow.call({}, textarea);
    assert.equal(textarea.style.height, '320px', 'longer text still grows it');
});
