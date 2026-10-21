// The wallet is named "Ethereum wallet" on every screen, whichever extension
// it is. App copy says so in source; the SDK and its patches still say
// "MetaMask", so walletMethodText rewrites that wording for display, for both
// methods, and Send to address then reads its own words for the wallet steps
// it does not have. Technical identifiers (the 'metamask' method value, data
// attributes, classes, URLs) are never rewritten.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { getWalletMethod, setWalletMethod, walletMethodText } from '../../chat/zkapi/services/walletMethod.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function withMethod(t, method) {
    const before = getWalletMethod();
    setWalletMethod(method);
    t.after(() => setWalletMethod(before));
}

// Lines the pinned SDKs and their recovery patch really emit.
const SDK_LINES = [
    ['MetaMask was not detected. Install or enable it, then reload this page.',
        'No Ethereum wallet was detected. Install or enable one, then reload this page.'],
    ['Confirm the mutual close in MetaMask…', 'Confirm the mutual close in your Ethereum wallet…'],
    ['MetaMask did not return a transaction ID.', 'Your Ethereum wallet did not return a transaction ID.'],
    ['Connect the MetaMask account 0xabc that submitted this withdrawal.',
        'Connect the Ethereum wallet account 0xabc that submitted this withdrawal.'],
    ['A MetaMask withdrawal request is still unresolved.', 'An Ethereum wallet withdrawal request is still unresolved.'],
    ['Only retry if the old MetaMask prompt is closed.', 'Only retry if the old Ethereum wallet prompt is closed.'],
    ['This asks MetaMask to submit the same deposit.', 'This asks your Ethereum wallet to submit the same deposit.'],
    ['<p>MetaMask may still be open.</p>', '<p>Your Ethereum wallet may still be open.</p>']
];

test('SDK wording reads "Ethereum wallet" for the Ethereum wallet method, grammatically', t => {
    withMethod(t, 'metamask');
    for (const [raw, shown] of SDK_LINES) {
        assert.equal(walletMethodText(raw), shown);
        assert.equal(walletMethodText(walletMethodText(raw)), shown, 'idempotent');
    }
});

test('Send to address keeps its own words for the wallet steps it does not have', t => {
    withMethod(t, 'address');
    const cases = [
        ['Connecting to MetaMask…', 'Preparing your funding address…'],
        ['Connecting to your Ethereum wallet…', 'Preparing your funding address…'],
        ['Waiting for MetaMask…', 'Preparing transaction…'],
        ['Waiting for your Ethereum wallet', 'Preparing transaction'],
        ['Finalize in your Ethereum wallet', 'Finalize withdrawal'],
        ['$1.78 returned to MetaMask.', '$1.78 sent to your withdrawal address.'],
        ['Use your Ethereum wallet once, then OA Chat handles private access automatically.',
            'Fund your address once, then OA Chat handles private access automatically.'],
        ['Connect the MetaMask account 0xabc that submitted this withdrawal.',
            'Connect your funding account 0xabc that submitted this withdrawal.']
    ];
    for (const [raw, shown] of cases) assert.equal(walletMethodText(raw), shown);
    assert.doesNotMatch(SDK_LINES.map(([raw]) => walletMethodText(raw)).join('\n'), /MetaMask|Ethereum wallet account/);
});

test('technical identifiers and links are never rewritten', t => {
    for (const method of ['metamask', 'address']) {
        withMethod(t, method);
        const html = '<button data-wallet-method="metamask" class="zkapi-transfer--metamask">'
            + '<a href="https://metamask.io/download/">x</a></button>';
        assert.equal(walletMethodText(html), html);
    }
});

// Every string and template literal of the app's own sources: no user-facing
// "MetaMask" is written into the app (the SDK's is rewritten above).
function sources(directory) {
    const found = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (!['vendor', 'node_modules', 'fonts', 'img'].includes(entry.name)) found.push(...sources(full));
        } else if (/\.(m?js)$/.test(entry.name)) found.push(full);
    }
    return found;
}

function walk(node, visit) {
    if (!node || typeof node.type !== 'string') return;
    visit(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(child => walk(child, visit));
        else if (value && typeof value.type === 'string') walk(value, visit);
    }
}

test('the app writes no "MetaMask" into what people read', () => {
    const offenders = [];
    for (const file of sources(path.join(ROOT, 'chat'))) {
        const source = fs.readFileSync(file, 'utf8');
        if (!source.includes('MetaMask')) continue;
        let ast;
        try { ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }); }
        catch { offenders.push(`${path.relative(ROOT, file)}: mentions MetaMask but does not parse`); continue; }
        walk(ast, node => {
            const text = node.type === 'Literal' && typeof node.value === 'string' ? node.value
                : node.type === 'TemplateElement' ? node.value.cooked ?? node.value.raw : null;
            if (text && /\bMetaMask\b/.test(text)) {
                offenders.push(`${path.relative(ROOT, file)}:${source.slice(0, node.start).split('\n').length}`);
            }
        });
    }
    assert.deepEqual(offenders, []);
});

test('index.html says nothing of MetaMask either', () => {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'chat/index.html'), 'utf8'), /\bMetaMask\b/);
});
