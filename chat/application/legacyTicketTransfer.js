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
 * code, never neither. Only aggregate counts leave this module.
 */
export class LegacyTicketTransfer {
    constructor({
        fetchInfo,
        submit,
        listTickets,
        removeTickets,
        holdKeyIds,
        pendingStore,
        getAccountScope,
        redeemPending,
        lockManager = globalThis.navigator?.locks,
        now = () => new Date().toISOString()
    }) {
        Object.assign(this, {
            fetchInfo, submit, listTickets, removeTickets, holdKeyIds,
            pendingStore, getAccountScope, redeemPending, lockManager, now
        });
    }

    async run() {
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
        return this.lockManager.request(TRANSFER_LOCK, () => this.transferHeld(keyId, info));
    }

    async transferHeld(keyId, info) {
        const accountId = await this.getAccountScope();
        if (!accountId) return { status: 'signed-out', moved: 0 };
        const scope = `account:${accountId}`;
        const batchSize = Math.max(1, Math.min(Number(info.max_batch) || DEFAULT_BATCH, DEFAULT_BATCH));
        // A stable order makes a retry after a lost reply the identical
        // request, which the org answers with the same code.
        const legacy = this.listTickets()
            .filter(ticket => ticket?.finalized_ticket && getTicketKeyId(ticket) === keyId)
            .sort((a, b) => (a.finalized_ticket < b.finalized_ticket ? -1 : a.finalized_ticket > b.finalized_ticket ? 1 : 0));

        let moved = 0;
        let savedCodes = 0;
        let stopped = null;
        for (const batch of chunk(legacy, batchSize)) {
            let result;
            try {
                result = await this.submit(batch.map(ticket => ticket.finalized_ticket));
            } catch (error) {
                if (error?.code === 'LEGACY_TRANSFER_CLOSED') {
                    this.holdKeyIds([]);
                    stopped = 'closed';
                    break;
                }
                if (error?.code === 'LEGACY_TRANSFER_LIMIT') {
                    stopped = 'limit';
                    break;
                }
                throw error;
            }
            const codes = [result?.code, ...(Array.isArray(result?.recovered_codes) ? result.recovered_codes : [])]
                .filter(code => typeof code === 'string' && code.length === 24);
            for (const code of new Set(codes)) {
                // Durable before the old tickets go: the code is now the value.
                await this.pendingStore.put({ scope, code, needsNewIssuer: true, createdAt: this.now() });
                savedCodes += 1;
            }
            const indexes = [
                ...(Array.isArray(result?.transferred) ? result.transferred : []),
                ...(Array.isArray(result?.already_transferred) ? result.already_transferred : [])
            ];
            const done = [...new Set(indexes)]
                .filter(index => Number.isInteger(index) && index >= 0 && index < batch.length)
                .map(index => batch[index]);
            if (done.length) await this.removeTickets(done, { expectedAccountId: accountId });
            moved += Number(result?.tickets) || 0;
        }

        // Redeem whatever codes are waiting, including ones saved by an
        // earlier run that stopped before redeeming.
        let redeemError = null;
        if (savedCodes > 0 || (await this.pendingStore.list(scope)).length > 0) {
            try {
                await this.redeemPending();
            } catch (error) {
                redeemError = error;
            }
        }
        return {
            status: stopped || (legacy.length ? 'moved' : 'none'),
            moved,
            redeemError
        };
    }
}
