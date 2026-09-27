import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../chat/zkapi/components/WelcomePanel.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export default class WelcomePanel', 'class WelcomePanel');

function fixture(method, phase) {
    const actions = [];
    const client = {
        suggestedDeposit: 10,
        isNativeEthFunding: true,
        config: { pending_deposit: { phase, amount: '4000000' } },
        formatMoney: amount => { assert.equal(amount, '4000000'); return '$12.00'; },
        deposit() { assert.fail('Opening saved progress cannot submit a deposit'); },
        quoteDepositUsd() { assert.fail('A saved deposit must never be repriced'); }
    };
    const context = {
        zkapiClient: client,
        addressFundingWallet: { pending: null },
        getWalletMethod: () => method,
        walletMethodText: value => value,
        renderWalletMethod: () => '', renderFundingAccount: () => '', fundingSetupGuide: () => '',
        prepareWalletMethod() { assert.fail('Opening saved progress cannot request wallet access'); }
    };
    const WelcomePanel = vm.runInNewContext(`${source}\nWelcomePanel;`, context);
    const welcome = Object.create(WelcomePanel.prototype);
    Object.assign(welcome, {
        busy: false, fundingBusy: false, escapeHtml: String,
        close() { actions.push('close'); },
        app: { accountModal: { openFunding() { actions.push('open-funding'); } } }
    });
    return { welcome, actions };
}

for (const method of ['address', 'metamask']) {
    for (const phase of ['prepared', 'retry_exact', 'submitted', 'awaiting_wallet', 'ambiguous']) {
        test(`Welcome keeps ${method} ${phase} recovery reachable without changing or submitting the saved amount`, async () => {
            const { welcome, actions } = fixture(method, phase);
            const html = welcome.renderWelcome();
            assert.match(html, /Saved deposit: \$12\.00/);
            assert.match(html, /id="welcome-resume-deposit-btn"/);
            assert.doesNotMatch(html, /id="welcome-deposit-amount"|id="welcome-fund-btn"/);
            assert.deepEqual(actions, [], 'Rendering is read-only');
            // Also cover a pending plan appearing after the ordinary Next button
            // was rendered: its existing click handler must hand off recovery.
            await welcome.fund();
            assert.deepEqual(actions, ['close', 'open-funding']);
        });
    }
}
