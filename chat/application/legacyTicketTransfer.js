import { getTicketKeyId, normalizeTicketKeyId } from '../domain/ticketKeys.js';

const TRANSFER_LOCK = 'oa-legacy-ticket-transfer-v1';
const DEFAULT_BATCH = 500;

function chunk(items, size) {
    const batches = [];
    for (let index = 0; index < items.length; index += size) {
        batches.push(items.slice(index, index + size));
    }
    return batches;
}

/**
 * One-time move of tickets signed by the previous production org.
 *
 * The org checks each old ticket against the previous org's public key and
 * answers with a redeem code for the same number. Each code is saved to the
 * durable code-recovery store BEFORE the old tickets leave the wallet, and is
 * then redeemed like any other code (fresh, blind-signed tickets under the
 * current key). A crash at any point leaves either the old tickets or a saved
 * code, never neither. Only aggregate counts leave this module, apart from
 * the tickets that cannot move (returned so the host can set them apart).
 *
 * Old tickets are taken from two places: the live wallet, and the snapshot a
 * login parks when an existing account replaces this browser's wallet (the
 * browser held old tickets, its person logged in instead of signing up).
 *
 * Tickets that cannot move are returned as `stranded`: those the org reports
 * invalid, and those over the transfer allowance. When the org refuses a
 * batch for the allowance, the part that fits is sent again on its own.
 */
export class LegacyTicketTransfer {
    constructor({
        fetchInfo,
        submit,
        listTickets,
        removeTickets,
        holdKeyIds,
        pendingStore,
        attemptStore,
        getAccountScope,
        redeemPending,
        onStart = () => {},
        listParkedTickets = async () => [],
        removeParkedTickets = async () => 0,
        lockManager = globalThis.navigator?.locks,
        now = () => new Date().toISOString()
    }) {
        Object.assign(this, {
            fetchInfo, submit, listTickets, removeTickets, holdKeyIds,
            pendingStore, attemptStore, getAccountScope, redeemPending, onStart,
            listParkedTickets, removeParkedTickets, lockManager, now
        });
    }

    async run({ expectedAccountId } = {}) {
        const info = await this.fetchInfo();
        const keyId = normalizeTicketKeyId(info?.key_id);
        if (!keyId || info?.enabled !== true) {
            // Closed or never configured: nothing is held back from spending.
            this.holdKeyIds([]);
            return { status: 'closed', moved: 0 };
        }
        // Old tickets can no longer be spent here; keep them out of selection
        // so no send picks one while they wait to be moved.
        this.holdKeyIds([keyId]);
        if (!this.lockManager?.request) {
            throw new Error('This browser cannot safely coordinate the ticket move across tabs.');
        }
        return this.lockManager.request(TRANSFER_LOCK, () => this.transferHeld(keyId, info, expectedAccountId));
    }

    async transferHeld(keyId, info, expectedAccountId) {
        const accountId = await this.getAccountScope();
        if (!accountId) return { status: 'signed-out', moved: 0 };
        if (expectedAccountId !== undefined && accountId !== expectedAccountId) {
            throw new Error('Your account changed before ticket restoration started.');
        }
        const scope = `account:${accountId}`;
        const batchSize = Math.max(1, Math.min(Number(info.max_batch) || DEFAULT_BATCH, DEFAULT_BATCH));
        const isLegacy = ticket => ticket?.finalized_ticket && getTicketKeyId(ticket) === keyId;
        // A stable order makes a retry after a lost reply the identical
        // request, which the org answers with the same code.
        const byTicket = (a, b) => (a.finalized_ticket < b.finalized_ticket ? -1 : a.finalized_ticket > b.finalized_ticket ? 1 : 0);
        let live = this.listTickets().filter(isLegacy).sort(byTicket);
        const inLive = new Set(live.map(ticket => ticket.finalized_ticket));
        // A failed read is not an empty wallet. Reject so the watcher retries
        // before issuing any credit or declaring this account finished.
        let parked = (await this.listParkedTickets() || [])
            .filter(ticket => isLegacy(ticket) && !inLive.has(ticket.finalized_ticket))
            .sort(byTicket);
        const attempt = await this.attemptStore.get();
        if (attempt && (attempt.accountId !== accountId || !Array.isArray(attempt.tickets) || !attempt.tickets.length)) {
            throw new Error('An unfinished ticket move belongs to another account. Return to that account to restore its tickets.');
        }
        const replay = attempt ? attempt.tickets.map(finalized_ticket => ({ finalized_ticket })) : [];
        if (replay.some(ticket => !isLegacy(ticket))) {
            throw new Error('The saved ticket move cannot be resumed with this issuer. Your tickets are retained.');
        }
        await this.assertAccount(accountId);
        if ((live.length || parked.length || replay.length) && info.account_binding !== true) {
            throw new Error('Ticket restoration is waiting for a server update. Your saved tickets are safe.');
        }
        // A journal keeps the exact request even if a later login parks or
        // replaces the wallet that originally held these tickets.
        const replayIds = new Set(replay.map(ticket => ticket.finalized_ticket));
        live = live.filter(ticket => !replayIds.has(ticket.finalized_ticket));
        parked = parked.filter(ticket => !replayIds.has(ticket.finalized_ticket));
        const total = live.length + parked.length + replay.length;
        if (total) this.onStart({ tickets: total, accountId });

        const known = new Set(
            (await this.pendingStore.list(scope)).map(record => record?.code).filter(Boolean)
        );
        const state = { moved: 0, savedCodes: 0, stopped: null, stranded: [] };
        const sources = [
            [replay, async done => {
                await this.removeTickets(done, { expectedAccountId: accountId });
                await this.removeParkedTickets(done, { expectedAccountId: accountId });
            }],
            [live, done => this.removeTickets(done, { expectedAccountId: accountId })],
            [parked, done => this.removeParkedTickets(done, { expectedAccountId: accountId })]
        ];
        for (let s = 0; s < sources.length; s += 1) {
            const [tickets, remove] = sources[s];
            await this.moveTickets(tickets, remove, { scope, accountId, batchSize: s === 0 ? replay.length : batchSize, known, state });
            if (state.stopped) {
                if (state.stopped === 'limit') {
                    // Nothing after the refusal fits either.
                    for (const [rest] of sources.slice(s + 1)) {
                        state.stranded.push(...rest.map(ticket => ticket.finalized_ticket));
                    }
                }
                break;
            }
        }

        await this.assertAccount(accountId);
        // Every consuming reply is now durable. Keep uncertain closed-window
        // work for recovery; a limit is a definitive refusal of the remainder.
        if (state.stopped !== 'closed') await this.attemptStore.clear();

        // Redeem whatever codes are waiting, including ones saved by an
        // earlier run that stopped before redeeming.
        let redeemError = null;
        let redeemed = false;
        if (state.savedCodes > 0 || (await this.pendingStore.list(scope)).length > 0) {
            try {
                await this.assertAccount(accountId);
                const recovery = await this.redeemPending({ expectedAccountId: accountId });
                // A redeemer may successfully finish some codes while retaining
                // others. A partial success must stay retryable, including after
                // reload when no old tickets remain and only saved codes exist.
                if (recovery?.pendingCount > 0 || (await this.pendingStore.list(scope)).length > 0) {
                    throw new Error('Some tickets are still being restored. Your saved credit will be retried.');
                }
                redeemed = true;
            } catch (error) {
                redeemError = error;
            }
        }
        await this.assertAccount(accountId);
        return {
            status: state.stopped || (total ? 'moved' : 'none'),
            moved: state.moved,
            redeemed,
            redeemError,
            stranded: state.stopped === 'closed' ? [] : state.stranded
        };
    }

    async assertAccount(accountId) {
        if (await this.getAccountScope() !== accountId) {
            throw new Error('Your account changed. Return to the original account to finish restoring its tickets.');
        }
    }

    async moveTickets(tickets, remove, { scope, accountId, batchSize, known, state }) {
        let index = 0;
        let size = batchSize;
        while (index < tickets.length) {
            await this.assertAccount(accountId);
            const batch = tickets.slice(index, index + size);
            let result;
            try {
                // Durable ownership BEFORE the consuming request. A lost reply
                // must not let another account discard the only recovery path.
                await this.attemptStore.put({ accountId, tickets: batch.map(ticket => ticket.finalized_ticket) });
                await this.assertAccount(accountId);
                result = await this.submit(batch.map(ticket => ticket.finalized_ticket), { expectedAccountId: accountId });
            } catch (error) {
                await this.assertAccount(accountId);
                if (error?.code === 'LEGACY_TRANSFER_CLOSED') {
                    this.holdKeyIds([]);
                    state.stopped = 'closed';
                    return;
                }
                if (error?.code === 'LEGACY_TRANSFER_LIMIT') {
                    // Send the part that fits on its own; the rest can't move.
                    const remaining = Math.max(0, Math.floor(Number(error.remaining) || 0));
                    if (remaining > 0 && remaining < batch.length) {
                        size = remaining;
                        continue;
                    }
                    state.stopped = 'limit';
                    state.stranded.push(...tickets.slice(index).map(ticket => ticket.finalized_ticket));
                    return;
                }
                throw error;
            }
            const codes = [result?.code, ...(Array.isArray(result?.recovered_codes) ? result.recovered_codes : [])]
                .filter(code => typeof code === 'string' && code.length === 24);
            for (const code of new Set(codes)) {
                // Durable before the old tickets go: the code is now the value.
                // A code already saved keeps its record (and any redemption
                // progress in it).
                if (!known.has(code)) {
                    await this.pendingStore.put({ scope, code, needsNewIssuer: true, createdAt: this.now() });
                    known.add(code);
                }
                state.savedCodes += 1;
            }
            // A reply may arrive after sign-out. Keep its credit under the
            // original account, but never mutate the replacement wallet.
            await this.assertAccount(accountId);
            const indexes = [
                ...(Array.isArray(result?.transferred) ? result.transferred : []),
                ...(Array.isArray(result?.already_transferred) ? result.already_transferred : [])
            ];
            const done = [...new Set(indexes)]
                .filter(position => Number.isInteger(position) && position >= 0 && position < batch.length)
                .map(position => batch[position]);
            if (done.length) await remove(done);
            await this.assertAccount(accountId);
            // Keep the last completed batch journal until the whole run has
            // settled, so switching tabs cannot reassign its remaining batches.
            // Invalid tickets never move; they stay out of the wallet's use.
            for (const position of Array.isArray(result?.invalid) ? result.invalid : []) {
                if (Number.isInteger(position) && position >= 0 && position < batch.length) {
                    state.stranded.push(batch[position].finalized_ticket);
                }
            }
            state.moved += Number(result?.tickets) || 0;
            index += batch.length;
            size = batchSize;
        }
    }
}
