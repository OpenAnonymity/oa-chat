// The wallet work the Private balance dialog does — a deposit, a mutual
// close, an escape start — shown as the steps it takes, the way a zkAPI
// chat shows "Private access". Pure: a kind, the latest status line the
// SDK reported, and the phase it persisted, in; steps with states, out.
// The persisted phase is what a reload has, so the same list is drawn
// after one, with the current step waiting and its actions underneath.

const STATES = ['complete', 'active', 'waiting', 'paused', 'upcoming', 'error'];

// With Send ETH (addressFunding) nobody confirms anything: this browser holds
// the funding address's key and signs the transaction itself. Its steps say
// what the browser does, and none of them waits on the person.
function stepsFor(kind, { hasLease = false, tokenSymbol = 'USDC', demoMint = false, nativeEth = false, escapePeriod = '', addressFunding = false } = {}) {
    if (kind === 'deposit' && addressFunding) {
        return [
            { id: 'connect', label: 'Prepare funding address', detail: 'Checks the ETH at this address and the current network fee.' },
            { id: 'deposit', label: 'Send the deposit', detail: 'This browser signs it and sends it from your funding address.' },
            { id: 'chain', label: 'Ethereum confirmation', detail: 'Your deposit has been submitted and is waiting to be confirmed on Ethereum.' }
        ];
    }
    if (kind === 'deposit') {
        return [
            { id: 'connect', label: 'Connect MetaMask', detail: 'Opens MetaMask to use your account.' },
            ...(demoMint ? [{ id: 'tokens', label: 'Get test billing tokens', detail: 'Confirm in MetaMask.' }] : []),
            ...(!nativeEth ? [{ id: 'approve', label: `Approve ${tokenSymbol}`, detail: 'Confirm in MetaMask. This lets the vault take the deposit, nothing more.' }] : []),
            { id: 'deposit', label: 'Confirm the deposit in MetaMask', detail: 'Moves the funds from your wallet into your private balance.' },
            { id: 'chain', label: 'Ethereum confirmation', detail: 'Your deposit has been submitted and is waiting to be confirmed on Ethereum.' }
        ];
    }
    const escape = kind === 'escape';
    return [
        ...(hasLease ? [{ id: 'settle', label: 'Settle the active chat key', detail: 'Finishes the open chat and confirms its usage.' }] : []),
        escape
            ? { id: 'proof', label: 'Generate the recovery proof', detail: 'Made on this device.' }
            : { id: 'proof', label: 'Prepare your withdrawal', detail: 'The zkAPI server authorizes it and this device makes the proof.' },
        addressFunding
            ? { id: 'wallet', label: escape ? 'Send the escape start' : 'Send your withdrawal', detail: 'This browser signs it and pays the network fee from your funding address.' }
            : escape
                ? { id: 'wallet', label: 'Confirm the escape start in MetaMask', detail: 'One transaction. Nothing moves before you confirm.' }
                : { id: 'wallet', label: 'Confirm your withdrawal in MetaMask', detail: 'Approve the transaction in MetaMask.' },
        escape
            ? { id: 'chain', label: 'Ethereum confirmation', detail: `Then a safety window${escapePeriod ? ` of ${escapePeriod}` : ''} before you finalize.` }
            : { id: 'chain', label: 'Ethereum confirmation', detail: 'Your withdrawal has been submitted and is waiting to be confirmed on Ethereum.' }
    ];
}

/** Which step a status line from the SDK belongs to, and whether that
 *  step is working (active) or waiting on the person (waiting). Null for
 *  a line that says nothing about position — the caller keeps its place. */
export function classifyWalletStatus(kind, message = '') {
    const text = String(message || '');
    if (!text) return null;
    if (/Withdrawal confirmed\.|returned to MetaMask|Escape started|is available in MetaMask|now visible in MetaMask/i.test(text)) return { step: 'done', state: 'complete' };
    if (/^(?:(?:Deposit|Withdrawal|Replacement|Background replacement|Finalization)(?: replacement)? submitted\b|Checking submitted\b)|waiting for confirmation|checking confirmation/i.test(text)) return { step: 'chain', state: 'active' };
    if (kind === 'deposit') {
        if (/Depositing into the private-note vault/i.test(text)) return { step: 'deposit', state: 'waiting' };
        if (/allowance|Approving/i.test(text)) return { step: 'approve', state: 'waiting' };
        if (/Minting|test billing tokens|test ZKAPI/i.test(text)) return { step: 'tokens', state: 'waiting' };
        if (/Connecting to MetaMask|Connecting to the MetaMask account/i.test(text)) return { step: 'connect', state: 'active' };
        if (/Confirm .*in MetaMask/i.test(text)) return { step: 'deposit', state: 'waiting' };
        return null;
    }
    if (/Finishing the active chat/i.test(text)) return { step: 'settle', state: 'active' };
    if (/Confirm the (mutual close|escape-hatch start)|Confirm .*in MetaMask|Opening .*MetaMask/i.test(text)) return { step: 'wallet', state: 'waiting' };
    if (/server clearance|withdrawal proof|Connecting to MetaMask|Retry authorized/i.test(text)) return { step: 'proof', state: 'active' };
    return null;
}

/** Where a persisted phase (what survives a reload) puts the journey. */
export function positionForPersistedPhase(kind, phase = '') {
    switch (String(phase || '')) {
        // Saved work that waits for the person's Continue: the step it
        // stopped at is paused — marked as the current one, not running.
        case 'reserving':
            return { step: 'proof', state: 'paused' };
        case 'prepared':
        case 'retry_exact':
            return kind === 'deposit' ? { step: 'deposit', state: 'paused' } : { step: 'wallet', state: 'paused' };
        case 'awaiting_wallet':
            return kind === 'deposit' ? { step: 'deposit', state: 'waiting' } : { step: 'wallet', state: 'waiting' };
        case 'submitted':
        case 'dropped_or_pending':
        case 'ambiguous':
            return { step: 'chain', state: 'active' };
        default:
            return null;
    }
}

/**
 * @param {object} input
 * @param {'deposit'|'withdraw'|'escape'} input.kind
 * @param {string} [input.message]   latest SDK status line (while busy)
 * @param {string} [input.persistedPhase]  prepared_withdrawal / pending_deposit phase
 * @param {{step:string,state:string}|null} [input.last]  previous position, kept when the message says nothing
 * @param {boolean} [input.failed]   the run ended in an error at the current step
 */
export function walletJourney({ kind, message = '', persistedPhase = '', last = null, failed = false, ...options } = {}) {
    const steps = stepsFor(kind, options);
    // A quote also has a saved deposit plan. Checking that plan does not mean
    // a transaction has been sent. Only submission status or durable recovery
    // state can move a deposit to the Ethereum step.
    const persisted = positionForPersistedPhase(kind, persistedPhase);
    const classified = classifyWalletStatus(kind, message);
    const position = kind === 'deposit' && persisted?.step === 'chain'
        ? persisted : classified || last || (message ? null : persisted) || { step: steps[0].id, state: 'active' };
    if (kind === 'deposit') {
        const chain = steps.find(step => step.id === 'chain');
        if (position.step === 'chain' && /Checking (the private-vault deposit|payment status)/i.test(message)) {
            chain.label = 'Checking your deposit';
            chain.detail = 'Looking for your saved deposit on Ethereum.';
        } else if (['ambiguous', 'dropped_or_pending'].includes(persistedPhase)) {
            chain.label = 'Deposit status unknown';
            chain.detail = 'Check its status before trying again.';
        }
    }
    const index = position.step === 'done' ? steps.length : Math.max(0, steps.findIndex(step => step.id === position.step));
    const named = STATES.includes(position.state) ? position.state : 'active';
    const state = options.addressFunding && named === 'waiting' ? 'active' : named;
    return {
        kind,
        position,
        category: kind === 'deposit' ? 'Adding your balance' : kind === 'escape' ? 'Starting account recovery'
            : ['reserving', 'prepared', 'retry_exact'].includes(persistedPhase) ? 'Withdrawal, paused' : 'Withdrawal',
        steps: steps.map((step, i) => ({
            ...step,
            state: i < index ? 'complete' : i === index ? (failed ? 'error' : state) : 'upcoming'
        })),
        done: position.step === 'done'
    };
}
