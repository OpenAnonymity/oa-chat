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
    const interrupted = walletJourney({ kind: 'withdraw', persistedPhase: 'reserving' });
    // Saved work waiting for Continue marks the step it stopped at as the
    // current one (paused), so the page reads as it did before the reload.
    assert.deepEqual(states(interrupted), ['proof:paused', 'wallet:upcoming', 'chain:upcoming']);
    assert.equal(interrupted.category, 'Withdrawal, paused');
    assert.deepEqual(positionForPersistedPhase('withdraw', 'awaiting_wallet'), { step: 'wallet', state: 'waiting' });
    assert.deepEqual(positionForPersistedPhase('deposit', 'submitted'), { step: 'chain', state: 'active' });
    assert.equal(positionForPersistedPhase('withdraw', ''), null);
    assert.deepEqual(states(walletJourney({ kind: 'withdraw', persistedPhase: 'prepared' })), ['proof:complete', 'wallet:paused', 'chain:upcoming']);
    assert.deepEqual(states(walletJourney({ kind: 'withdraw', persistedPhase: 'awaiting_wallet' })), ['proof:complete', 'wallet:waiting', 'chain:upcoming']);
    assert.deepEqual(states(walletJourney({ kind: 'deposit', persistedPhase: 'dropped_or_pending' })), ['connect:complete', 'approve:complete', 'deposit:complete', 'chain:active']);
    assert.deepEqual(states(walletJourney({ kind: 'withdraw', persistedPhase: 'awaiting_wallet', failed: true })), ['proof:complete', 'wallet:error', 'chain:upcoming']);
});

test('native ETH funding has one deposit confirmation without token approval', () => {
    const journey = walletJourney({ kind: 'deposit', nativeEth: true, tokenSymbol: 'ETH',
        message: 'Depositing into the private-note vault… confirm in MetaMask.' });
    assert.deepEqual(states(journey), ['connect:complete', 'deposit:waiting', 'chain:upcoming']);
    assert(!journey.steps.some(step => /Approve|test billing/.test(step.label)));
});


test('deposit journey distinguishes unknown, checking, and submitted outcomes', () => {
    const chain = options => walletJourney({ kind: 'deposit', ...options }).steps.find(s => s.id === 'chain');
    assert.equal(chain({ persistedPhase: 'ambiguous' }).label, 'Deposit status unknown');
    assert.equal(chain({ persistedPhase: 'submitted' }).label, 'Ethereum confirmation');
    const checking = chain({ message: 'Checking the private-vault deposit…', persistedPhase: 'submitted', last: { step: 'deposit', state: 'waiting' } });
    assert.equal(checking.label, 'Checking your deposit');
    assert.equal(checking.state, 'active');
});

test('with Send ETH the browser signs, so the steps say what it does and none waits on the person', () => {
    let last = null;
    const at = message => { const j = walletJourney({ kind: 'deposit', message, last, nativeEth: true, addressFunding: true }); last = j.position; return j; };
    const preparing = at('Connecting to MetaMask…');
    assert.deepEqual(preparing.steps.map(step => step.label), ['Prepare funding address', 'Send the deposit', 'Ethereum confirmation']);
    assert.doesNotMatch(JSON.stringify(preparing.steps), /MetaMask|confirm in your funding account/i);
    const sending = at('Depositing into the private-note vault… confirm in MetaMask.');
    assert.deepEqual(states(sending), ['connect:complete', 'deposit:active', 'chain:upcoming'], 'working, not waiting on anyone');
    assert.match(sending.steps[1].detail, /This browser signs it/);
    assert.deepEqual(states(at('Deposit submitted 0xabc… waiting for confirmation…')), ['connect:complete', 'deposit:complete', 'chain:active']);
    const withdraw = walletJourney({ kind: 'withdraw', message: 'Confirm the mutual close in MetaMask…', addressFunding: true });
    assert.equal(withdraw.steps[1].label, 'Send your withdrawal');
    assert.equal(withdraw.steps[1].state, 'active');
    assert.deepEqual(walletJourney({ kind: 'deposit', nativeEth: true }).steps.map(step => step.id), ['connect', 'deposit', 'chain'], 'MetaMask keeps its own steps');
    assert.equal(walletJourney({ kind: 'deposit', nativeEth: true }).steps[1].label, 'Confirm the deposit in MetaMask');
});

test('checking an unsubmitted Send ETH draft never jumps ahead of sending', () => {
    let last = null;
    const at = (message, persistedPhase = 'prepared') => {
        const journey = walletJourney({ kind: 'deposit', nativeEth: true, addressFunding: true, message, persistedPhase, last });
        last = journey.position;
        return states(journey);
    };
    assert.deepEqual(at('Checking funds…'), ['connect:active', 'deposit:upcoming', 'chain:upcoming']);
    assert.deepEqual(at('Connecting to MetaMask…'), ['connect:active', 'deposit:upcoming', 'chain:upcoming']);
    assert.deepEqual(at('Checking the private-vault deposit…'), ['connect:active', 'deposit:upcoming', 'chain:upcoming']);
    assert.deepEqual(at('Generating the private note commitment locally…'), ['connect:active', 'deposit:upcoming', 'chain:upcoming']);
    assert.deepEqual(at('Depositing into the private-note vault… confirm in MetaMask.', 'awaiting_wallet'), ['connect:complete', 'deposit:active', 'chain:upcoming']);
    assert.deepEqual(at('Deposit submitted 0xabc… · waiting for confirmation…', 'submitted'), ['connect:complete', 'deposit:complete', 'chain:active']);
    assert.deepEqual(at('Connecting to the MetaMask account that submitted this deposit…', 'submitted'), ['connect:complete', 'deposit:complete', 'chain:active']);
    assert.deepEqual(at('Checking the private-vault deposit…', 'submitted'), ['connect:complete', 'deposit:complete', 'chain:active']);
});

test('mentions of earlier or absent submissions do not claim a new transaction was sent', () => {
    assert.deepEqual(classifyWalletStatus('deposit', 'Connecting to the MetaMask account that submitted this deposit…'), { step: 'connect', state: 'active' });
    assert.equal(classifyWalletStatus('escape', 'No escape transaction was submitted. Your private balance is ready to use.'), null);
});
