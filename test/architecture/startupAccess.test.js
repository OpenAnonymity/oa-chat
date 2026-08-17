import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const appPath = path.join(repoRoot, 'chat/app.js');
const indexPath = path.join(repoRoot, 'chat/index.html');
const accountModalPath = path.join(repoRoot, 'chat/components/AccountModal.js');
const rightPanelPath = path.join(repoRoot, 'chat/components/RightPanel.js');

test('empty local wallets are not gated by automatic access modals', () => {
    const appSource = readFileSync(appPath, 'utf8');
    const indexSource = readFileSync(indexPath, 'utf8');
    const accountModalSource = readFileSync(accountModalPath, 'utf8');
    const rightPanelSource = readFileSync(rightPanelPath, 'utf8');

    assert.equal(appSource.includes('this.welcomePanel.init()'), false);
    assert.equal(appSource.includes('this.thanksPanel.init()'), false);
    assert.equal(indexSource.includes('Apply welcome panel state immediately'), false);

    // Removing automatic onboarding must not remove either optional access path.
    assert.equal(appSource.includes('await accountService.init()'), true);
    assert.equal(indexSource.includes('id="account-tab-btn"'), true);
    assert.equal(indexSource.includes('account-tab-dot'), false);
    assert.equal(accountModalSource.includes("document.getElementById('account-tab-btn')"), true);
    assert.equal(rightPanelSource.includes('this.showInvitationForm = true'), true);
    assert.equal(rightPanelSource.includes('tickets.alphaRegister(invitationCode'), true);
});
