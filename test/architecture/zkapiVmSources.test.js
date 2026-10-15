import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// A direct devDependency (also what terser parses with).
import { parse } from 'acorn';

// Four sources are evaluated by tests inside a vm with their import lines
// stripped and a hand-built context supplying each imported name:
//   chat/zkapi/components/AccountModal.js
//   chat/zkapi/components/WelcomePanel.js
//   chat/zkapi/components/WalletMethodControls.js
//   chat/zkapi/services/walletMethod.mjs
// A name that one of them starts using without that context supplying it is a
// ReferenceError in a test, or worse in a path no test reaches. So they reach
// everything version-related through `zkapiClient.oaVersioning?.<member>`
// (zkapiClient is already in scope) and gain no import. This test pins their
// import lists and the set of names they read that nothing declares (free
// identifiers). Adding an import means updating the vm contexts of every test
// that evaluates the file, and this pin, in the same change.

const repoRoot = process.cwd();
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

// `import X from 'm'`, `import { a, b } from 'm'`; multi-line lists included.
function importsOf(source) {
    const entries = [];
    for (const match of source.matchAll(/^import\s+([\s\S]*?)\s+from\s+'([^']+)';/gm)) {
        const clause = match[1].trim();
        const names = clause.startsWith('{')
            ? clause.slice(1, clause.lastIndexOf('}')).split(',').map(name => name.trim()).filter(Boolean)
            : [clause];
        entries.push({ from: match[2], names });
    }
    return entries;
}

const PINNED = {
    'chat/zkapi/components/AccountModal.js': [
        { from: './WalletModalMotion.js', names: ['revealWithdrawalTopUp'] },
        { from: './StatusIcon.js', names: ['statusIcon'] },
        { from: './WithdrawalFees.js', names: ['attachWithdrawalFees', 'needsWithdrawalFees', 'refreshWithdrawalFees', 'renderWithdrawalFeeLine', 'renderWithdrawalFees', 'stopWithdrawalFees', 'withdrawalFeeReady', 'withdrawalFeeReceiptAmounts'] },
        { from: './FundingDisclosures.js', names: ['fundingDisclosure', 'attachFundingDisclosures', 'captureFundingDisclosureView', 'restoreFundingDisclosureView'] },
        { from: '../../ui/uiMotion.js', names: ['showSurface', 'hideSurface', 'revealText', 'motionDuration'] },
        { from: '@openanonymity/zkapi-browser-sdk/client', names: ['zkapiClient'] },
        { from: '../services/privateAccessSettlement.js', names: ['settlePrivateAccess'] },
        { from: '../services/withdrawalRecovery.mjs', names: ['availableWithdrawalEscape', 'sameWithdrawalEscape', 'assertWithdrawalEscapeAvailable', 'canCancelPreparedWithdrawal', 'escapeNeedsSettlement', 'assertEscapeReady'] },
        { from: '../services/depositAmount.mjs', names: ['ethUnits', 'formatSuggestedDeposit'] },
        { from: '../services/canceledDeposit.mjs', names: ['depositOperationId', 'isWalletCancellation', 'resetCanceledDeposit'] },
        { from: '../services/welcomeModalIntent.mjs', names: ['readWelcomeModalIntent', 'writeWelcomeModalIntent'] },
        { from: './WalletModalView.js', names: ['attachWalletModalRestoreCancellation', 'cancelWalletModalRestore', 'currentWalletModalRestore', 'finishWalletModalRestore'] },
        // The host's copy of the legacy SDK's amount parser (same names).,
        { from: '../services/tokenAmount.mjs', names: ['parseTokenAmount'] },
        { from: '@openanonymity/zkapi-browser-sdk/wallet-error', names: ['walletErrorMessage'] },
        { from: '../services/zkapiErrorCopy.mjs', names: ['explainZkapiError', 'isIndexerLag', 'pendingDepositMessage'] },
        { from: './ZkapiStateExperience.js', names: ['updateZkapiBalanceControl'] },
        { from: './FundingSetupGuide.js', names: ['captureFundingSetupView', 'fundingSetupGuide', 'restoreFundingSetupView'] },
        { from: '../domain/walletJourney.js', names: ['walletJourney'] },
        { from: '../services/addressFundingProvider.mjs', names: ['addressFundingWallet'] },
        { from: '../services/addressFunding.js', names: ['canQuotePendingAddressDeposit', 'formatFundingAmount', 'runAddressAction', 'withdrawalDestination'] },
        { from: '../services/walletMethod.mjs', names: ['getWalletMethod', 'initWalletClient', 'initWalletMethod', 'prepareWalletMethod', 'setWalletMethod', 'subscribeWalletMethod', 'walletMethodText'] },
        { from: './WalletMethodControls.js', names: ['attachWalletMethodControls', 'captureWalletView', 'fundingInstructionsVisible', 'refreshWalletView', 'renderDepositAmount', 'prepareDepositAmount', 'renderFundingAccount', 'renderFundingWei', 'fundingUsdText', 'renderMetaMaskTransfer', 'renderWalletMethod', 'restoreWalletView', 'stopFundingFlow', 'isFundingViewHydrating', 'syncWalletFlows'] },
        { from: './PrivateBalanceHelp.js', names: ['attachPrivateBalanceHelp', 'capturePrivateBalanceHelpFocus', 'privateBalanceExpiryLabel', 'privateBalanceExpired', 'privateBalanceGuide', 'privateBalanceHelpButton', 'privateBalanceHelpContent', 'restorePrivateBalanceHelpFocus', 'updatePrivateBalanceExpiryState'] }
    ],
    'chat/zkapi/components/WelcomePanel.js': [
        { from: './FundingDisclosures.js', names: ['attachFundingDisclosures'] },
        { from: '../../ui/uiMotion.js', names: ['showSurface', 'hideSurface'] },
        { from: '../../services/conversationLink.js', names: ['hasConversationParam'] },
        { from: '@openanonymity/zkapi-browser-sdk/client', names: ['zkapiClient'] },
        { from: '../services/canceledDeposit.mjs', names: ['depositOperationId', 'isWalletCancellation', 'resetCanceledDeposit'] },
        { from: '../services/depositAmount.mjs', names: ['formatSuggestedDeposit'] },
        { from: '../services/welcomeModalIntent.mjs', names: ['readWelcomeModalIntent', 'writeWelcomeModalIntent'] },
        { from: './WalletModalView.js', names: ['attachWalletModalRestoreCancellation', 'cancelWalletModalRestore', 'currentWalletModalRestore', 'finishWalletModalRestore'] },
        { from: './FundingSetupGuide.js', names: ['captureFundingSetupView', 'fundingSetupGuide', 'restoreFundingSetupView'] },
        { from: '../services/addressFundingProvider.mjs', names: ['addressFundingWallet'] },
        { from: '../services/addressFunding.js', names: ['runAddressAction'] },
        { from: '../services/zkapiErrorCopy.mjs', names: ['isIndexerLag', 'pendingDepositMessage', 'zkapiErrorMessage'] },
        { from: '../services/walletMethod.mjs', names: ['getWalletMethod', 'initWalletClient', 'prepareWalletMethod', 'setWalletMethod', 'subscribeWalletMethod', 'walletMethodText'] },
        { from: './WalletMethodControls.js', names: ['attachWalletMethodControls', 'captureWalletView', 'refreshWalletView', 'renderDepositAmount', 'prepareDepositAmount', 'renderFundingAccount', 'renderWalletMethod', 'restoreWalletView', 'stopFundingFlow', 'isFundingViewHydrating'] }
    ],
    'chat/zkapi/components/WalletMethodControls.js': [
        { from: '@openanonymity/zkapi-browser-sdk/client', names: ['zkapiClient'] },
        { from: '../../db.js', names: ['chatDB'] },
        { from: '../services/addressFundingProvider.mjs', names: ['addressFundingWallet'] },
        { from: '../services/addressDepositFlow.mjs', names: ['AddressDepositFlow'] },
        { from: '../services/depositAmount.mjs', names: ['DepositAmount', 'formatSuggestedDeposit'] },
        { from: './FundingPaymentQr.js', names: ['renderFundingPaymentQr'] },
        { from: './FundingProgress.js', names: ['renderFundingProgress'] },
        { from: '../../ui/uiMotion.js', names: ['motionDuration'] },
        { from: '../services/walletMethod.mjs', names: ['getWalletMethod', 'setWalletMethod', 'prepareWalletMethod', 'walletMethodActionBusy'] },
        { from: '../services/addressFunding.js', names: ['canQuotePendingAddressDeposit', 'formatFundingAmount', 'fundingEthAmount', 'fundingDestination'] }
    ],
    'chat/zkapi/services/walletMethod.mjs': [
        { from: '@openanonymity/zkapi-browser-sdk/client', names: ['zkapiClient'] },
        { from: './addressFundingProvider.mjs', names: ['addressFundingWallet'] }
    ]
};

for (const [file, pinned] of Object.entries(PINNED)) {
    test(`${file} keeps its pinned import list`, () => {
        const actual = importsOf(read(file));
        assert.deepEqual(actual, pinned,
            'An import was added, removed or re-pointed. The vm-evaluated tests supply imports by name: update their contexts and this pin together.');
    });

    test(`${file} reaches versions only through zkapiClient.oaVersioning`, () => {
        const source = read(file);
        // No dynamic import() or require(): the vm has neither, and a lazy
        // import is an import that this list could not see.
        assert.equal(/\bimport\s*\(/.test(source), false, 'no dynamic import()');
        assert.equal(/\brequire\s*\(/.test(source), false, 'no require()');
        // The version modules and helpers are never imported by name.
        for (const entry of importsOf(source)) {
            assert.equal(/\/versioning\//.test(entry.from), false, `${file} imports ${entry.from}`);
            assert.equal(/UpgradeView|VersionNotices|scopedFundingProviders/.test(entry.from), false, `${file} imports ${entry.from}`);
        }
        // Build defines are free identifiers in a vm; the facade carries them.
        assert.equal(/__OA_ZKAPI_/.test(source), false, 'no build define');
    });
}

test('the host amount parser replaces the SDK import in the account dialog', () => {
    const imports = importsOf(read('chat/zkapi/components/AccountModal.js'));
    assert.equal(imports.some(entry => /zkapi-browser-sdk\/wallet$/.test(entry.from)), false,
        'parseTokenAmount must come from the host copy, not the SDK package a version may not have');
    const parser = imports.find(entry => entry.names.includes('parseTokenAmount'));
    assert.equal(parser?.from, '../services/tokenAmount.mjs');
});

test('the sources that stay pure take no DOM, storage or facade import', () => {
    // UpgradeView.js is a pure string renderer; it is composed by ui.js and
    // never imported by a vm-evaluated source (checked above).
    const source = read('chat/zkapi/components/UpgradeView.js');
    for (const entry of importsOf(source)) {
        assert.match(entry.from, /^\.\.\/versioning\/(copy|upgradeFlow)\.mjs$/, entry.from);
    }
    assert.equal(/\b(?:document|window|localStorage|sessionStorage|indexedDB|fetch)\b/.test(source.replace(/\/\/.*$/gm, '')), false);
});

// ---------------------------------------------------------------------------
// Free identifiers
// ---------------------------------------------------------------------------
//
// Names read but declared nowhere in the file: ECMAScript built-ins (every vm
// context has them) and the few browser globals these files have always used
// (a vm test supplies those it exercises, and the existing code already
// guards or contexts every one of them). A new name outside both lists is a
// ReferenceError waiting in a vm, so it fails here.

const ECMASCRIPT_BUILTINS = new Set([
    'Array', 'BigInt', 'Boolean', 'Date', 'Error', 'Intl', 'JSON', 'Map', 'Math', 'Number', 'Object',
    'Promise', 'RegExp', 'Set', 'String', 'Symbol', 'TypeError', 'WeakMap', 'WeakSet', 'globalThis',
    'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'undefined'
]);

// Pinned from the sources as they were before versions existed.
const BROWSER_GLOBALS = {
    'chat/zkapi/components/AccountModal.js': ['clearTimeout', 'document', 'queueMicrotask', 'setTimeout', 'window'],
    'chat/zkapi/components/WelcomePanel.js': ['URLSearchParams', 'clearTimeout', 'document', 'localStorage', 'queueMicrotask', 'setTimeout', 'window'],
    'chat/zkapi/components/WalletMethodControls.js': ['Event', 'Infinity', 'clearTimeout', 'navigator', 'queueMicrotask', 'setTimeout'],
    'chat/zkapi/services/walletMethod.mjs': ['setTimeout']
};

function patternNames(node, out) {
    if (!node) return;
    switch (node.type) {
        case 'Identifier': out.add(node.name); break;
        case 'ObjectPattern': node.properties.forEach(entry => patternNames(entry.type === 'RestElement' ? entry.argument : entry.value, out)); break;
        case 'ArrayPattern': node.elements.forEach(entry => patternNames(entry, out)); break;
        case 'RestElement': patternNames(node.argument, out); break;
        case 'AssignmentPattern': patternNames(node.left, out); break;
        default: break;
    }
}

// Every identifier read somewhere in `source` that no declaration anywhere in
// the file binds. Flat on purpose: it finds an undeclared name, not a shadowed one.
function freeIdentifiers(source) {
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const declared = new Set();
    const read = new Set();
    const visit = (node, parent, key) => {
        if (!node || typeof node.type !== 'string') return;
        switch (node.type) {
            case 'ImportDeclaration': node.specifiers.forEach(specifier => declared.add(specifier.local.name)); break;
            case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
                if (node.id) declared.add(node.id.name);
                node.params.forEach(param => patternNames(param, declared));
                break;
            case 'ClassDeclaration': case 'ClassExpression': if (node.id) declared.add(node.id.name); break;
            case 'VariableDeclarator': patternNames(node.id, declared); break;
            case 'CatchClause': patternNames(node.param, declared); break;
            case 'Identifier': {
                let reference = true;
                if (parent) {
                    if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) reference = false;
                    if (['Property', 'PropertyDefinition', 'MethodDefinition'].includes(parent.type) && key === 'key' && !parent.computed) reference = false;
                    if (['LabeledStatement', 'BreakStatement', 'ContinueStatement', 'MetaProperty'].includes(parent.type)) reference = false;
                    if (['FunctionDeclaration', 'FunctionExpression', 'ClassDeclaration', 'ClassExpression'].includes(parent.type) && key === 'id') reference = false;
                    if (parent.type === 'VariableDeclarator' && key === 'id') reference = false;
                    if (parent.type === 'CatchClause' && key === 'param') reference = false;
                }
                if (reference) read.add(node.name);
                break;
            }
            default: break;
        }
        for (const field of Object.keys(node)) {
            if (['type', 'start', 'end', 'loc'].includes(field)) continue;
            const value = node[field];
            if (Array.isArray(value)) value.forEach(child => visit(child, node, field));
            else if (value && typeof value.type === 'string') visit(value, node, field);
        }
    };
    visit(ast, null, null);
    return [...read].filter(name => !declared.has(name)).sort();
}

for (const [file, globals] of Object.entries(BROWSER_GLOBALS)) {
    test(`${file} reads no name that its vm contexts do not already supply`, () => {
        const allowed = new Set([...ECMASCRIPT_BUILTINS, ...globals]);
        const unexpected = freeIdentifiers(read(file)).filter(name => !allowed.has(name));
        assert.deepEqual(unexpected, [],
            'A new free identifier. Reach version context through zkapiClient.oaVersioning?.<member>, or pin the global here with every vm context that evaluates this file.');
    });
}

test('the free-identifier scan sees an undeclared name', () => {
    assert.deepEqual(freeIdentifiers("import { a } from 'x';\nconst b = a + c;\nfunction f(d) { return d + e; }"), ['c', 'e']);
});
