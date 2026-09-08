import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { hasOpenModalDialog } from '../../chat/ui/modalLayer.js';

const dialog = visible => ({ getClientRects: () => (visible ? [{}] : []) });

test('a visible aria-modal dialog owns the keyboard; hidden ones do not', () => {
    const doc = list => ({ querySelectorAll: selector => {
        assert.equal(selector, '[aria-modal="true"]');
        return list;
    } });
    assert.equal(hasOpenModalDialog(doc([])), false);
    assert.equal(hasOpenModalDialog(doc([dialog(false), dialog(false)])), false);
    assert.equal(hasOpenModalDialog(doc([dialog(false), dialog(true)])), true);
    assert.equal(hasOpenModalDialog(undefined), false);
});

test('typing and Enter stay out of the composer while a dialog is open', () => {
    const app = fs.readFileSync(path.join(process.cwd(), 'chat/app.js'), 'utf8');
    assert.match(app, /import \{ hasOpenModalDialog \} from '\.\/ui\/modalLayer\.js';/);
    const handler = app.slice(app.indexOf('// Send message on Enter if no input is focused'), app.indexOf('// Handle global paste events'));
    // Both the Enter-to-send branch and the auto-focus branch consult it.
    assert.equal((handler.match(/!hasOpenModalDialog\(\)/g) || []).length, 2);
    // The Log in dialog is one of them.
    const modal = fs.readFileSync(path.join(process.cwd(), 'chat/components/AccountModal.js'), 'utf8');
    assert.match(modal, /aria-modal="true"[^>]*account-login-dialog/);
});
