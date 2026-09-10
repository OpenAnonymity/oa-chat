// The wallet work the Private balance dialog does — a deposit, a mutual
// close, an escape start — shown as the steps it takes, the way a zkAPI
// chat shows "Private access". Pure: a kind, the latest status line the
// SDK reported, and the phase it persisted, in; steps with states, out.
// The persisted phase is what a reload has, so the same list is drawn
// after one, with the current step waiting and its actions underneath.

const STATES = ['complete', 'active', 'waiting', 'upcoming', 'error'];

function stepsFor(kind, { hasLease = false, tokenSymbol = 'USDC', demoMint = false, escapePeriod = '' } = {}) {
    if (kind === 'deposit') {
        return [
            { id: 'connect', label: 'Connect MetaMask' },
            ...(demoMint ? [{ id: 'tokens', label: 'Get test billing tokens', detail: 'Confirm in MetaMask.' }] : []),
            { id: 'approve', label: `Approve ${tokenSymbol}`, detail: 'Confirm in MetaMask. This lets the vault take the deposit, nothing more.' },
            { id: 'deposit', label: 'Confirm the deposit in MetaMask', detail: 'One transaction. Nothing moves before you confirm.' },
            { id: 'chain', label: 'Wait for the chain', detail: 'Usually under a minute.' }
        ];
    }
    const escape = kind === 'escape';
    return [
        ...(hasLease ? [{ id: 'settle', label: 'Settle the active chat key', detail: 'Finishes the open chat and confirms its usage.' }] : []),
        escape
            ? { id: 'proof', label: 'Generate the recovery proof', detail: 'Made on this device.' }
            : { id: 'proof', label: 'Request server clearance and generate the proof', detail: 'zkAPI co-signs the close; the proof is made on this device.' },
        escape
            ? { id: 'wallet', label: 'Confirm the escape start in MetaMask', detail: 'One transaction. Nothing moves before you confirm.' }
            : { id: 'wallet', label: 'Confirm the close in MetaMask', detail: 'One transaction. Nothing moves before you confirm.' },
        escape
            ? { id: 'chain', label: 'Wait for the chain', detail: `Then a safety window${escapePeriod ? ` of ${escapePeriod}` : ''} before you finalize.` }
            : { id: 'chain', label: 'Wait for the chain', detail: 'Usually under a minute.' }
    ];
}

/** Which step a status line from the SDK belongs to, and whether that
 *  step is working (active) or waiting on the person (waiting). Null for
 *  a line that says nothing about position — the caller keeps its place. */
export function classifyWalletStatus(kind, message = '') {
    const text = String(message || '');
    if (!text) return null;
    if (/returned to MetaMask|Escape started|is available in MetaMask|now visible in MetaMask/i.test(text)) return { step: 'done', state: 'complete' };
    if (/submitted|waiting for confirmation|Checking submitted|checking confirmation/i.test(text)) return { step: 'chain', state: 'active' };
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
        case 'prepared':
        case 'retry_exact':
            return kind === 'deposit' ? { step: 'deposit', state: 'upcoming' } : { step: 'wallet', state: 'upcoming' };
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
    const position = classifyWalletStatus(kind, message) || last || positionForPersistedPhase(kind, persistedPhase) || { step: steps[0].id, state: 'active' };
    const index = position.step === 'done' ? steps.length : Math.max(0, steps.findIndex(step => step.id === position.step));
    const state = STATES.includes(position.state) ? position.state : 'active';
    return {
        kind,
        position,
        category: kind === 'deposit' ? 'Adding your balance' : kind === 'escape' ? 'Starting account recovery' : 'Returning your balance',
        steps: steps.map((step, i) => ({
            ...step,
            state: i < index ? 'complete' : i === index ? (failed ? 'error' : state) : 'upcoming'
        })),
        done: position.step === 'done'
    };
}
