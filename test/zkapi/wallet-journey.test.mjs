import test from 'node:test';
import assert from 'node:assert/strict';
import { walletJourney, classifyWalletStatus, positionForPersistedPhase } from '../../chat/zkapi/domain/walletJourney.js';

const states = journey => journey.steps.map(step => `${step.id}:${step.state}`);

test('a mutual close walks proof → wallet → chain from the SDK status lines', () => {
    let last = null;
    const at = message => { const j = walletJourney({ kind: 'withdraw', message, last }); last = j.position; return states(j); };
    assert.deepEqual(at('Connecting to MetaMask…'), ['proof:active', 'wallet:upcoming', 'chain:upcoming']);
    assert.deepEqual(at('Requesting server clearance and generating the withdrawal proof…'), ['proof:active', 'wallet:upcoming', 'chain:upcoming']);
    assert.deepEqual(at('Confirm the mutual close in MetaMask…'), ['proof:complete', 'wallet:waiting', 'chain:upcoming']);
    assert.deepEqual(at('Withdrawal submitted 0x3f9a…c21e · waiting for confirmation…'), ['proof:complete', 'wallet:complete', 'chain:active']);
    assert.deepEqual(at('$1.78 returned to MetaMask.'), ['proof:complete', 'wallet:complete', 'chain:complete']);
});

test('an active chat key adds a settle step first; an escape names its own steps', () => {
    const j = walletJourney({ kind: 'withdraw', message: 'Finishing the active chat and confirming its usage…', hasLease: true });
    assert.deepEqual(states(j), ['settle:active', 'proof:upcoming', 'wallet:upcoming', 'chain:upcoming']);
    const e = walletJourney({ kind: 'escape', message: 'Confirm the escape-hatch start in MetaMask…', escapePeriod: '1 day' });
    assert.equal(e.category, 'Starting account recovery');
    assert.match(e.steps[1].label, /escape start/);
    assert.match(e.steps[2].detail, /safety window of 1 day/);
});

test('a line that says nothing about position keeps the last one', () => {
    const j = walletJourney({ kind: 'withdraw', message: 'Some other words', last: { step: 'wallet', state: 'waiting' } });
    assert.deepEqual(states(j), ['proof:complete', 'wallet:waiting', 'chain:upcoming']);
    assert.equal(classifyWalletStatus('withdraw', 'Some other words'), null);
});

test('a deposit walks connect → approve → deposit → chain, with test tokens on a testnet', () => {
    const at = (message, extra = {}) => states(walletJourney({ kind: 'deposit', message, tokenSymbol: 'USDC', ...extra }));
    assert.deepEqual(at('Connecting to MetaMask…'), ['connect:active', 'approve:upcoming', 'deposit:upcoming', 'chain:upcoming']);
    assert.deepEqual(at('Approving USDC… confirm in MetaMask.'), ['connect:complete', 'approve:waiting', 'deposit:upcoming', 'chain:upcoming']);
    assert.deepEqual(at('Depositing into the private-note vault… confirm in MetaMask.'), ['connect:complete', 'approve:complete', 'deposit:waiting', 'chain:upcoming']);
    assert.deepEqual(at('Deposit submitted 0xabc… · waiting for confirmation…'), ['connect:complete', 'approve:complete', 'deposit:complete', 'chain:active']);
    assert.deepEqual(at('Minting free test billing tokens… confirm in MetaMask.', { demoMint: true }), ['connect:complete', 'tokens:waiting', 'approve:upcoming', 'deposit:upcoming', 'chain:upcoming']);
    assert.equal(walletJourney({ kind: 'deposit', message: 'Approving USDC… confirm in MetaMask.' }).category, 'Adding your balance');
});

test('after a reload the persisted phase places the journey, and a failure marks the step', () => {
    assert.deepEqual(positionForPersistedPhase('withdraw', 'awaiting_wallet'), { step: 'wallet', state: 'waiting' });
    assert.deepEqual(positionForPersistedPhase('deposit', 'submitted'), { step: 'chain', state: 'active' });
    assert.equal(positionForPersistedPhase('withdraw', ''), null);
    assert.deepEqual(states(walletJourney({ kind: 'withdraw', persistedPhase: 'prepared' })), ['proof:complete', 'wallet:upcoming', 'chain:upcoming']);
    assert.deepEqual(states(walletJourney({ kind: 'withdraw', persistedPhase: 'awaiting_wallet' })), ['proof:complete', 'wallet:waiting', 'chain:upcoming']);
    assert.deepEqual(states(walletJourney({ kind: 'deposit', persistedPhase: 'dropped_or_pending' })), ['connect:complete', 'approve:complete', 'deposit:complete', 'chain:active']);
    assert.deepEqual(states(walletJourney({ kind: 'withdraw', persistedPhase: 'awaiting_wallet', failed: true })), ['proof:complete', 'wallet:error', 'chain:upcoming']);
});
