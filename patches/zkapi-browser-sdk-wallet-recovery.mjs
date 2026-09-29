// Compatibility repair for the exact pinned SDK. Remove when its upstream fix is pinned.
export default {
    revision: 'cf56d67e0c1dd4bc3f3c32392478ce242c746446',
    files: [
        {
            file: 'sdk/services/browserWalletRuntime.js',
            beforeSha256: '65540f04dfca699193cf5a3377bff8aa25a1d4d3d4d8c23ad47c859ff5a31d67',
            afterSha256: 'd544fae3ed07df9a2887f1ff8a4efbf0df94289734a446c52613255a700164fb',
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
            ]
        },
        {
            file: 'sdk/services/zkapiClient.js',
            beforeSha256: '03aa06fbfe9f7632042dd83fbaebdb85839b248b1668c4eacf6066926e347194',
            afterSha256: '94208c3fca60337f843d0af2a345e91930964ca8f28dee430b1648dbb618d1ed',
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
        const requestedDestination = normalizeWithdrawalDestination(destination, this.config?.funding);
        const operationKey = \`\${mode}:\${requestedDestination || ''}\`;`,
                    after: `    async withdraw(mode, onStatus = () => {}, { destination, expectedWithdrawalOperationId = null } = {}) {
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
            ]
        },
    ]
};
