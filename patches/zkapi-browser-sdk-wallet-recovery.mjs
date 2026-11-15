// Compatibility repair for the exact pinned SDK. Remove when its upstream fix is pinned.
export default {
    revision: '3342c95871e8422bb878ad40072687c241a68a5b',
    files: [
        {
            file: 'sdk/services/browserWalletRuntime.js',
            beforeSha256: '57e1c18365d4853f4926cc49fbe80f24bda730359c0bbe7b55d4f61e0378942c',
            afterSha256: 'cf51ddfdf381e810c4c3322968e3ecbd94976e22e27a9df0847e3827ea69e565',
            replacements: [
                {
                    before: `const LATE_DEPOSIT_TERMINAL_STATUSES = new Set(['confirmed', 'reverted', 'superseded']);`,
                    after: `const LATE_DEPOSIT_TERMINAL_STATUSES = new Set(['confirmed', 'reverted', 'superseded']);

// A rejected retry says nothing about an earlier send with an unknown result.
// Its original append slot must stay frozen until finality resolves that send.
function hasUnresolvedDepositSubmission(pending) {
    return Boolean(pending.legacyRecovery || (pending.ambiguousSubmissions || []).some(attempt =>
        !(pending.resolvedAmbiguousSubmissionIds || []).includes(attempt.submissionId)));
}`
                },
                {
                    before: `                if (Number(pending.amount) !== Number(amount)) {
                    if (pending.phase !== 'prepared'`,
                    after: `                if (pending.phase === 'prepared' && hasUnresolvedDepositSubmission(pending)) {
                    pending = { ...pending, phase: 'retry_exact' };
                    await this.commit({ ...this.runtime, pendingDeposit: pending });
                }
                if (Number(pending.amount) !== Number(amount)) {
                    if (pending.phase !== 'prepared'`
                },
                {
                    before: `            if (pending.phase !== 'prepared' || pending.submissionId || hashes.length) {
                throw new Error('This deposit already has a wallet attempt. Check it before refreshing the vault path.');
            }`,
                    after: `            if (pending.phase !== 'prepared' || pending.submissionId || hashes.length
                || hasUnresolvedDepositSubmission(pending)) {
                throw new Error('This deposit already has a wallet attempt. Check it before refreshing the vault path.');
            }`
                },
                {
                    before: `            return this.runtime.pendingDeposit ? { ...this.runtime.pendingDeposit } : null;
        });
    }

    async claimPendingDepositSubmission`,
                    after: `            const pending = this.runtime.pendingDeposit;
            // Repair records written by older clients after a canceled retry.
            // Status reads retain the original note and never authorize a send.
            if (pending?.phase === 'prepared' && hasUnresolvedDepositSubmission(pending)) {
                const repaired = { ...pending, phase: 'retry_exact' };
                await this.commit({ ...this.runtime, pendingDeposit: repaired });
                return repaired;
            }
            return pending ? { ...pending } : null;
        });
    }

    async claimPendingDepositSubmission`
                },
                {
                    before: `                        : pending.fundingQuoteRetryAuthorized === true && pending.ambiguousSubmissions?.length
                            ? 'retry_exact' : 'prepared',`,
                    after: `                        : hasUnresolvedDepositSubmission(pending) ? 'retry_exact' : 'prepared',`
                },
                {
                    before: `async prepareWithdrawal(mode, destination, { expectedActiveRoot = null } = {})`,
                    after: `async prepareWithdrawal(mode, destination, { expectedActiveRoot = null, expectedNoteId = null } = {})`
                },
                {
                    before: `            if (!this.runtime.state) throw new Error('There is no active private note to withdraw.');
            if (unresolvedLateWithdrawalForNote`,
                    after: `            if (!this.runtime.state) throw new Error('There is no active private note to withdraw.');
            if (expectedNoteId != null && Number(this.runtime.state.note_id) !== Number(expectedNoteId)) {
                throw new Error('The private balance changed while withdrawal was opening. Review the current balance before continuing.');
            }
            if (unresolvedLateWithdrawalForNote`
                },
                {
                    before: `            if (!this.runtime.state) throw new Error('There is no active private note to withdraw.');
            // Recovery can discover`,
                    after: `            if (!this.runtime.state) throw new Error('There is no active private note to withdraw.');
            if (expectedNoteId != null && Number(this.runtime.state.note_id) !== Number(expectedNoteId)) {
                throw new Error('The private balance changed while withdrawal was opening. Review the current balance before continuing.');
            }
            // Recovery can discover`
                },
                {
                    before: `async prepareWithdrawal(mode, destination, { expectedActiveRoot = null, expectedNoteId = null } = {})`,
                    after: `async prepareWithdrawal(mode, destination, { expectedActiveRoot = null, expectedNoteId = null, expectedWithdrawalOperationId = null } = {})`
                },
                {
                    before: `            const validateExisting = (prepared) => {
                if (!prepared) return;`,
                    after: `            const validateExisting = (prepared) => {
                const cleanJournal = prepared && ['reserving', 'prepared'].includes(prepared.phase)
                    && !prepared.legacyRecovery && !prepared.submissionId && !prepared.submissionOwner
                    && !prepared.submissionFrom && prepared.submissionNonce == null
                    && !prepared.submissionNonceJournalRequired && !prepared.transactionHash
                    && !prepared.transactionHashes?.length && !prepared.transactionAttempts?.length
                    && !prepared.ambiguousSubmissions?.length && !prepared.ambiguousReplacements?.length
                    && !unresolvedLateWithdrawalForNote(this.runtime, this.runtime.state.note_id);
                // Host presentation checks cannot hold this lock across wallet
                // connection. Revalidate the chosen recovery inside preparation.
                if (expectedWithdrawalOperationId != null
                    && (prepared?.operationId !== expectedWithdrawalOperationId || !cleanJournal)) {
                    throw new Error('The saved withdrawal changed. Check its status before choosing the escape hatch again.');
                }
                if (!prepared) return;`
                },
                {
                    before: `                const hasSubmission = Boolean(prepared.submissionId || existingHashes.length);
                const safeModeSwitch = !hasSubmission && (`,
                    after: `                const safeModeSwitch = cleanJournal && (`
                },
                {
                    before: `            if (!force && hashes.length) {
                throw new Error('This withdrawal may already be in MetaMask. Check its transaction status before canceling it.');
            }`,
                    after: `            if (!force && (hashes.length || prepared.transactionHash
                || prepared.legacyRecovery || prepared.submissionOwner || prepared.submissionFrom
                || prepared.submissionNonce != null || prepared.submissionNonceJournalRequired
                || prepared.transactionAttempts?.length || prepared.ambiguousSubmissions?.length
                || prepared.ambiguousReplacements?.length
                || ['awaiting_wallet', 'ambiguous', 'submitted', 'dropped_or_pending'].includes(prepared.phase)
                || unresolvedLateWithdrawalForNote(this.runtime, prepared.noteId ?? prepared.public_inputs?.note_id))) {
                throw new Error('This withdrawal may already be in MetaMask. Check its transaction status before canceling it.');
            }`
                },
                {
                    before: `    async claimPreparedWithdrawalSubmission() {
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            let prepared = this.runtime.preparedWithdrawal;
            if (!prepared) throw new Error('The durable prepared withdrawal is missing.');`,
                    after: `    async claimPreparedWithdrawalSubmission(expected = null) {
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            let prepared = this.runtime.preparedWithdrawal;
            if (!prepared) throw new Error('The durable prepared withdrawal is missing.');
            if (expected && (!expected.operationId || !expected.destination
                || prepared.operationId !== expected.operationId
                || Number(prepared.noteId ?? prepared.public_inputs?.note_id) !== Number(expected.noteId)
                || prepared.mode !== expected.mode
                || prepared.destination?.toLowerCase() !== expected.destination.toLowerCase())) {
                throw new Error('The saved withdrawal changed before its wallet request. Check its status before continuing.');
            }`
                },
                {
                    before: `            let clearance = null;
            let withdrawalNullifier = existing?.withdrawalNullifier`,
                    after: `            // Reproof changes cryptographic inputs, not the operation's
            // unresolved wallet history. Keep that history even if clearance
            // or proof work is interrupted before the final commit.
            const recoveryJournal = { ...(existing || {}) };
            delete recoveryJournal.proof;
            delete recoveryJournal.public_inputs;
            let clearance = null;
            let withdrawalNullifier = existing?.withdrawalNullifier`
                },
                {
                    before: `                    preparedWithdrawal: {
                        phase: 'reserving',
                        mode,
                        operationId: existing?.operationId || uuid(),`,
                    after: `                    preparedWithdrawal: {
                        ...recoveryJournal,
                        phase: 'reserving',
                        mode,
                        operationId: existing?.operationId || uuid(),`
                },
                {
                    before: `            const plan = await this.worker.call('prepareWithdrawal', {
                config: this.config.wallet_core,
                state: this.runtime.state,`,
                    after: `            const generated = await this.worker.call('prepareWithdrawal', {
                config: this.config.wallet_core,
                state: this.runtime.state,`
                },
                {
                    before: `                provingKey: this.config.proving_keys.withdrawal
            });
            plan.destination = destination;`,
                    after: `                provingKey: this.config.proving_keys.withdrawal
            });
            const plan = { ...recoveryJournal, ...generated };
            plan.destination = destination;`
                },
                {
                    before: `    async prepareWithdrawal(mode, destination, { expectedActiveRoot = null, expectedNoteId = null, expectedWithdrawalOperationId = null } = {}) {
        await this.init();
        await this.settleActiveLease();`,
                    after: `    async assertEscapeReady() {
        await this.init();
        return withBrowserWalletLock(this.manifest.deployment_id, async () => {
            await this.reload();
            if (this.runtime?.journal || this.runtime?.lease || this.activeLease) {
                throw new BrowserWalletHttpError(
                    'Finish updating your previous chat balance before starting escape. This needs the temporary-key service; if it is unavailable, keep this browser data and retry when it returns.',
                    409, 'escape_settlement_required');
            }
        });
    }

    async prepareWithdrawal(mode, destination, { expectedActiveRoot = null, expectedNoteId = null, expectedWithdrawalOperationId = null } = {}) {
        await this.init();
        if (mode === 'escape') await this.assertEscapeReady();
        else await this.settleActiveLease();`
                },
                {
                    before: `            await this.recoverPendingLocked({ retireLostKey: true });
            await this.reload();
            if (!this.runtime.state) throw new Error('There is no active private note to withdraw.');`,
                    after: `            // A new key could appear while the initial guard released the lock.
            // Escape never silently depends on server settlement or clears its journal.
            if (mode === 'escape') {
                if (this.runtime.journal || this.runtime.lease || this.activeLease) {
                    throw new BrowserWalletHttpError('Finish updating your previous chat balance before starting escape.', 409, 'escape_settlement_required');
                }
            } else await this.recoverPendingLocked({ retireLostKey: true });
            await this.reload();
            if (!this.runtime.state) throw new Error('There is no active private note to withdraw.');`
                }
            ]
        },
        {
            file: 'sdk/services/zkapiClient.js',
            beforeSha256: 'ccdf8393743f1f8ab28fdea1ff378a6ed92b258a026ec32cc9fc19cb8c6eaa4e',
            afterSha256: 'd775f83308a29cc0f2b7216c4de6782b23f9c6dab61ad4007d29d58b6cdb9a9d',
            replacements: [
                {
                    before: `        await browserWalletRuntime.markPendingDepositUnknown();
        await this.refresh();
        onStatus('The old wallet prompt was marked unresolved. Check the vault before retrying.');`,
                    after: `        const pending = await browserWalletRuntime.pendingDeposit();
        if (pending?.submissionOutcome === 'replacement_awaiting_wallet'
            && pending.submissionId && pending.submissionNonce != null
            && Number.isSafeInteger(Number(pending.submissionNonce))
            && Number(pending.submissionNonce) >= 0 && pending.transactionHashes?.length) {
            // Reload can interrupt a replacement before its hash returns. The
            // original hash and nonce remain saved; another exact replacement
            // cannot cause two deposits at that nonce to execute.
            await browserWalletRuntime.releasePendingDepositReplacementClaim({
                operationId: pending.operationId,
                submissionId: pending.submissionId,
                replacementNonce: Number(pending.submissionNonce)
            });
        } else {
            await browserWalletRuntime.markPendingDepositUnknown();
        }
        await this.refresh();
        onStatus('The old wallet prompt was marked unresolved. Check the vault before retrying.');`
                },
                {
                    before: `        const plan = await browserWalletRuntime.pendingDeposit();
        if (!plan) return null;
        onStatus('Checking the private-vault deposit…');`,
                    after: `        let plan = await browserWalletRuntime.pendingDeposit();
        if (!plan) return null;
        if (plan.phase === 'ambiguous' && plan.submissionOutcome === 'replacement_awaiting_wallet') {
            // Older clients kept a dismissed replacement claim forever. The
            // user already marked its prompt closed; recover its original nonce
            // without connecting a wallet or submitting another transaction.
            await this.recoverUnknownDeposit(onStatus);
            plan = await browserWalletRuntime.pendingDeposit();
            if (!plan) return null;
        }
        onStatus('Checking the private-vault deposit…');`
                },
                {
                    before: `await browserWalletRuntime.prepareWithdrawal(mode, destination, { expectedActiveRoot })`,
                    after: `await browserWalletRuntime.prepareWithdrawal(mode, destination, { expectedActiveRoot, expectedNoteId: note.note_id })`
                },
                {
                    before: `    async withdraw(mode, onStatus = () => {}, { destination } = {}) {
        // The password dialog must not transfer an earlier withdrawal click
        // to a successor note installed by another tab while it was open.
        const expectedNoteId = this.note?.note_id;
        // Unilateral escape remains independent of the service credential.
        // Only cooperative withdrawal requests the server's authorization.
        if (mode === 'mutual') await this.ensureTestnetAccess({ interactive: true });
        if (this.note?.note_id !== expectedNoteId) {
            throw new Error('The private balance changed while withdrawal was opening. Review the current balance before continuing.');
        }
        const requestedDestination = normalizeWithdrawalDestination(destination, this.config?.funding);
        const operationKey = \`\${mode}:\${requestedDestination || ''}\`;`,
                    after: `    async withdraw(mode, onStatus = () => {}, { destination, expectedWithdrawalOperationId = null } = {}) {
        // The password dialog must not transfer an earlier withdrawal click
        // to a successor note installed by another tab while it was open.
        const expectedNoteId = this.note?.note_id;
        // Unilateral escape remains independent of the service credential.
        // Only cooperative withdrawal requests the server's authorization.
        if (mode === 'mutual') await this.ensureTestnetAccess({ interactive: true });
        if (this.note?.note_id !== expectedNoteId) {
            throw new Error('The private balance changed while withdrawal was opening. Review the current balance before continuing.');
        }
        const requestedDestination = normalizeWithdrawalDestination(destination, this.config?.funding);
        const operationKey = JSON.stringify([mode, requestedDestination || '', expectedWithdrawalOperationId]);`
                },
                {
                    before: `const operation = this.performWithdrawal(mode, onStatus, { destination });`,
                    after: `const operation = this.performWithdrawal(mode, onStatus, { destination, expectedWithdrawalOperationId });`
                },
                {
                    before: `async performWithdrawal(mode, onStatus = () => {}, { destination: requested } = {})`,
                    after: `async performWithdrawal(mode, onStatus = () => {}, { destination: requested, expectedWithdrawalOperationId = null } = {})`
                },
                {
                    before: `await browserWalletRuntime.prepareWithdrawal(mode, destination, { expectedActiveRoot, expectedNoteId: note.note_id })`,
                    after: `await browserWalletRuntime.prepareWithdrawal(mode, destination, { expectedActiveRoot, expectedNoteId: note.note_id, expectedWithdrawalOperationId })`
                },
                {
                    before: `                    const claim = await browserWalletRuntime.claimPreparedWithdrawalSubmission();
                    submission = claim;`,
                    after: `                    const claim = await browserWalletRuntime.claimPreparedWithdrawalSubmission({
                        operationId: plan.operationId,
                        noteId: Number(plan.noteId ?? plan.public_inputs?.note_id),
                        mode,
                        destination
                    });
                    submission = claim;`
                },
                {
                    before: `import { bufferedGasLimit } from './zkapiGas.mjs';`,
                    after: `import { bufferedGasLimit, MAX_TRANSACTION_GAS_LIMIT } from './zkapiGas.mjs';`
                },
                {
                    before: `    async withdraw(mode, onStatus = () => {}, { destination, expectedWithdrawalOperationId = null } = {}) {`,
                    after: `    async getWithdrawalFeeBudget(mode = 'mutual') {
        if (!['mutual', 'escape'].includes(mode)) throw new Error('Choose a withdrawal method.');
        if (!this.config?.funding || !this.ethereum?.request) throw new Error('Connect MetaMask to check the network fee.');
        const quantity = value => {
            if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value)) throw new Error('Invalid wallet fee data.');
            return BigInt(value);
        };
        const accounts = await this.ethereum.request({ method: 'eth_accounts' });
        const address = accounts?.[0]?.toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(address || '') || /^0x0{40}$/.test(address)) {
            throw Object.assign(new Error('Connect MetaMask to check the network fee.'), { code: 'withdrawal_wallet_disconnected' });
        }
        await this.assertFundingChain();
        const gasPrice = quantity(await this.ethereum.request({ method: 'eth_gasPrice' }));
        if (gasPrice <= 0n) throw new Error('Invalid wallet fee data.');
        // Before clearance the calldata does not exist. Reserve the supported
        // gas ceiling with price headroom; MetaMask still reviews the actual fee.
        const transactionFee = BigInt(MAX_TRANSACTION_GAS_LIMIT) * gasPrice * 2n;
        const reserve = transactionFee * (mode === 'escape' ? 2n : 1n);
        if (reserve >= 1n << 256n) throw new Error('Invalid wallet fee data.');
        const balance = quantity(await this.ethereum.request({ method: 'eth_getBalance', params: [address, 'pending'] }));
        await this.assertFundingChain();
        const current = await this.ethereum.request({ method: 'eth_accounts' });
        if (current?.[0]?.toLowerCase() !== address) throw new Error('MetaMask account changed. Check the fee again.');
        return { address, chainId: Number(this.config.funding.chain_id), mode,
            balanceWei: balance.toString(), feeReserveWei: reserve.toString(), transactionFeeWei: transactionFee.toString(),
            shortfallWei: (reserve > balance ? reserve - balance : 0n).toString(), expiresAt: Date.now() + 30_000 };
    }

    async assertWithdrawalFunding(from, mode, reviewed = null) {
        // Browser custody enforces its own reviewed allowance at the signing boundary.
        if (typeof this.ethereum?.withAuthorizedAction === 'function') return;
        const quote = await this.getWithdrawalFeeBudget(mode);
        if (quote.address !== from.toLowerCase() || (reviewed && (quote.address !== reviewed.address
            || quote.chainId !== reviewed.chainId || quote.mode !== reviewed.mode
            || BigInt(quote.feeReserveWei) > BigInt(reviewed.feeReserveWei)))) {
            throw Object.assign(new Error('MetaMask account or network fees changed. Review the withdrawal again.'), { code: 'withdrawal_fee_changed' });
        }
        if (quote.shortfallWei !== '0') {
            throw Object.assign(new Error('Add ETH to your MetaMask account for the network fee before withdrawing.'), { code: 'withdrawal_insufficient_eth' });
        }
    }

    async withdraw(mode, onStatus = () => {}, { destination, expectedWithdrawalOperationId = null, reviewedFunding = null } = {}) {`
                },
                {
                    before: `        const operation = this.performWithdrawal(mode, onStatus, { destination, expectedWithdrawalOperationId });`,
                    after: `        const operation = this.performWithdrawal(mode, onStatus, { destination, expectedWithdrawalOperationId, reviewedFunding });`
                },
                {
                    before: `    async performWithdrawal(mode, onStatus = () => {}, { destination: requested, expectedWithdrawalOperationId = null } = {}) {`,
                    after: `    async performWithdrawal(mode, onStatus = () => {}, { destination: requested, expectedWithdrawalOperationId = null, reviewedFunding = null } = {}) {`
                },
                {
                    before: `        await this.settleActiveLease(onStatus);

        onStatus('Connecting to MetaMask…');`,
                    after: `        if (mode === 'escape' && this.browserMode) await browserWalletRuntime.assertEscapeReady();

        onStatus('Connecting to MetaMask…');`
                },
                {
                    before: `        if (prepared?.transaction_hash) mode = prepared.mode;`,
                    after: `        if (prepared?.transaction_hash) mode = prepared.mode;
        else {
            await this.assertWithdrawalFunding(from, mode, reviewedFunding);
            if (mode === 'mutual') await this.settleActiveLease(onStatus);
        }`
                },
                {
                    before: `        onStatus('Connecting to MetaMask for the set-aside balance…');
        const from = await this.connectWallet();`,
                    after: `        onStatus('Connecting to MetaMask for the set-aside balance…');
        const from = await this.connectWallet();
        await this.assertWithdrawalFunding(from, 'mutual');`
                }
            ]
        },
        {
            file: 'sdk/services/browserWalletStore.js',
            beforeSha256: '1a6ff5b9e23c56ee1eed87c35a2e8391d1fb30f9a0ee6d7fa2dffbedc598f48d',
            afterSha256: '8c3642ed85c77783d334f20f76c4ac378bd2cdd39571b886ae8f07463bf26215',
            replacements: [
                {
                    before: `    const previous = fallbackLock;
    let release;
    fallbackLock = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
        return await operation();
    } finally {
        release();
    }`,
                    after: `    // A tab-local promise cannot protect the shared IndexedDB wallet.
    throw Object.assign(new Error('Private payments require a browser with Web Locks support. Update your browser before continuing.'), { code: 'wallet_lock_unavailable' });`
                }
            ]
        }
    ]
};
