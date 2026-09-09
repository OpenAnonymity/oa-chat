import assert from 'node:assert/strict';
import test from 'node:test';
import {
    attachPrivateBalanceHelp, capturePrivateBalanceHelpFocus, privateBalanceExpiryLabel,
    privateBalanceExpired, privateBalanceHelpButton, privateBalanceHelpContent,
    restorePrivateBalanceHelpFocus, updatePrivateBalanceExpiryState
} from '../../chat/zkapi/components/PrivateBalanceHelp.js';

function helpRoot(scope = 'panel') {
    const content = { billing: { hidden: true }, expiry: { hidden: true } };
    const buttons = ['billing', 'expiry'].map(kind => {
        const listeners = new Map();
        return {
            id: `zkapi-${scope}-${kind}-help-toggle`, dataset: { zkapiHelp: kind },
            attributes: new Map(), focusCount: 0,
            addEventListener: (type, listener) => listeners.set(type, listener),
            click: () => listeners.get('click')?.(),
            setAttribute(name, value) { this.attributes.set(name, value); },
            focus() { this.focusCount += 1; }
        };
    });
    return { buttons, content,
        contains: element => buttons.includes(element),
        querySelectorAll: () => buttons,
        querySelector(selector) {
            if (selector.startsWith('#')) return buttons.find(button => `#${button.id}` === selector);
            return content[selector.match(/="(\w+)"/)?.[1]];
        }
    };
}

test('billing and expiry help have distinct accessible controls and truthful withdrawal copy', () => {
    for (const scope of ['panel', 'modal']) {
        for (const kind of ['billing', 'expiry']) {
            const button = privateBalanceHelpButton(scope, kind, false);
            assert.match(button, /type="button"/);
            assert.match(button, /aria-expanded="false"/);
            assert.match(button, new RegExp(`aria-controls="zkapi-${scope}-${kind}-help"`));
            assert.match(button, /aria-label="[^"]+"/);
            assert.match(button, /focus-visible:ring-2/);
            assert.match(privateBalanceHelpContent(scope, kind), /data-zkapi-help-content="\w+" hidden>/);
        }
    }
    const expiry = privateBalanceHelpContent('panel', 'expiry', true);
    assert.match(expiry, /not a temporary chat key/);
    assert.match(expiry, /does not automatically refund/);
    assert.match(expiry, /address you choose/);
    assert.match(expiry, /used funds go to the service/);
    assert.match(expiry, /service treasury can claim the full original deposit/);
    assert.doesNotMatch(expiry, / hidden>/);
});

test('help clicks patch only their own disclosure and preserve independent open preferences', () => {
    const root = helpRoot();
    const owner = {};
    attachPrivateBalanceHelp(root, owner);
    root.buttons[0].click();
    assert.equal(root.content.billing.hidden, false);
    assert.equal(root.content.expiry.hidden, true);
    assert.equal(root.buttons[0].attributes.get('aria-expanded'), 'true');
    root.buttons[1].click();
    assert.deepEqual(owner.privateBalanceHelpOpen, { billing: true, expiry: true });
    root.buttons[0].click();
    assert.deepEqual(owner.privateBalanceHelpOpen, { billing: false, expiry: true });
    assert.equal(root.content.billing.hidden, true);
    assert.equal(root.buttons[0].attributes.get('aria-expanded'), 'false');
    assert.match(privateBalanceHelpContent('panel', 'billing', owner.privateBalanceHelpOpen.billing), / hidden>/);
    assert.doesNotMatch(privateBalanceHelpContent('panel', 'expiry', owner.privateBalanceHelpOpen.expiry), / hidden>/);
});

test('a semantic refresh restores only the focused help control within the same surface', t => {
    const previous = globalThis.document;
    t.after(() => { globalThis.document = previous; });
    const root = helpRoot();
    globalThis.document = { activeElement: root.buttons[1] };
    const focusedId = capturePrivateBalanceHelpFocus(root);
    assert.equal(focusedId, root.buttons[1].id);
    const replacement = helpRoot();
    restorePrivateBalanceHelpFocus(replacement, focusedId);
    assert.equal(replacement.buttons[1].focusCount, 1);
    assert.equal(replacement.buttons[0].focusCount, 0);
    assert.equal(capturePrivateBalanceHelpFocus(helpRoot('modal')), null);
    document.activeElement = { id: 'unrelated-input', dataset: {} };
    assert.equal(capturePrivateBalanceHelpFocus(root), null);
});

test('expired balances never render the misleading phrase expires in expired', () => {
    const client = { formatExpiry: value => value };
    assert.equal(privateBalanceExpiryLabel(client, '29 days'), 'expires in 29 days');
    assert.equal(privateBalanceExpiryLabel(client, 'expired'), 'expired');
});

test('crossing the expiry deadline patches only readiness and the unclaimed-balance notice', () => {
    const classes = new Set(['badge-status-success']);
    const badge = { textContent: 'ready', classList: { toggle(name, on) {
        if (on) classes.add(name); else classes.delete(name);
    } } };
    const notice = { hidden: true };
    const root = { querySelector(selector) {
        if (selector === '[data-private-balance-readiness]') return badge;
        assert.equal(selector, '[data-private-balance-expired-notice]');
        return notice;
    } };
    const note = { expiry_ts: 100 };
    assert.equal(privateBalanceExpired(note, 99_999), false);
    updatePrivateBalanceExpiryState(root, note, 100_000);
    assert.equal(badge.textContent, 'expired');
    assert.equal(notice.hidden, false);
    assert.equal(classes.has('badge-status-success'), false);
    assert.equal(classes.has('bg-amber-100'), true);
});
