import { buildTicketIssuanceRequest } from '../domain/ticketKeys.js';

function validateResponse(record) {
    const responses = record.response.signed_responses;
    if ((record.response.key_id && record.response.key_id !== record.keyId) ||
        !Array.isArray(responses) || responses.length !== record.requests.length ||
        responses.some(pair => !Array.isArray(pair) || pair.length !== 2 || !Number.isInteger(pair[0]) || pair[0] < 0 || pair[0] >= record.requests.length || typeof pair[1] !== 'string' || !pair[1]) ||
        new Set(responses.map(pair => pair[0])).size !== record.requests.length) {
        throw new Error('The server returned an invalid ticket signature batch. Your saved redemption is retained.');
    }
    return responses;
}

const yieldToUI = () => new Promise(resolve => setTimeout(resolve, 0));

/** Owns a redemption across view changes. Only aggregate results leave the core. */
export class TicketCodeRedeemer {
    constructor({ pendingStore, privacyPass, ticketStore, getAccountScope, fetchIssuer, submit, lockManager = globalThis.navigator?.locks }) {
        Object.assign(this, { pendingStore, privacyPass, ticketStore, getAccountScope, fetchIssuer, submit, lockManager });
    }

    async scope() {
        await this.ticketStore.init?.();
        const accountId = await this.getAccountScope();
        return { accountId: accountId || null, key: accountId ? `account:${accountId}` : 'anonymous' };
    }

    async getPending() {
        const scope = await this.scope();
        const records = await this.pendingStore.list(scope.key);
        return Object.freeze({ count: records.length });
    }

    async run(code, onProgress) {
        const scope = await this.scope();
        if (!this.lockManager?.request) {
            throw new Error('This browser cannot safely coordinate ticket-code redemption across tabs.');
        }
        return this.lockManager.request('oa-ticket-code-redemption-v1', async () => {
            await this.assertScope(scope);
            const pending = await this.pendingStore.list(scope.key);
            if (code !== null) {
                const normalized = String(code || '').trim().replace(/[\s-]+/g, '');
                if (normalized.length !== 24 || !/^[0-9a-f]{4}$/i.test(normalized.slice(-4)) || parseInt(normalized.slice(-4), 16) === 0) {
                    throw new Error('Invalid ticket code format.');
                }
                const record = pending.find(item => item.code === normalized);
                return this.finish(record || await this.prepare(normalized, scope, onProgress), scope, onProgress);
            }
            let result = null;
            let firstError = null;
            for (const record of pending) {
                try { result = await this.finish(record, scope, onProgress); }
                catch (error) { firstError ||= error; }
            }
            if (!result && firstError) throw firstError;
            return result ? { ...result, pendingCount: (await this.pendingStore.list(scope.key)).length } : null;
        });
    }

    async assertScope(scope) {
        if ((await this.getAccountScope() || null) !== scope.accountId) {
            throw new Error('Your wallet changed. Return to the original wallet to finish redeeming this code.');
        }
    }

    async prepare(code, scope, progress) {
        progress?.('Preparing tickets…', 2);
        if (!await this.privacyPass.checkAvailability()) throw new Error('Privacy Pass is unavailable.');
        const issuer = await this.fetchIssuer();
        const keyId = await this.privacyPass.getPublicKeyId(issuer.public_key);
        if (issuer.key_id && issuer.key_id !== keyId) throw new Error('Inconsistent ticket issuer key.');
        const count = parseInt(code.slice(-4), 16);
        const challenge = await this.privacyPass.createChallenge('oa-station', ['oa-station-api']);
        const requests = [];
        for (let index = 0; index < count; index++) {
            const { blindedRequest, serializedState } = await this.privacyPass.createSingleTokenRequest(issuer.public_key, challenge);
            if (!serializedState) throw new Error('Ticket blinding state could not be saved.');
            requests.push({ index, blindedRequest, serializedState });
            progress?.(`Blinding tickets… (${index + 1}/${count})`, 5 + Math.round((index + 1) / count * 60));
            if (index % 8 === 0) await yieldToUI();
        }
        await this.assertScope(scope);
        const record = { scope: scope.key, code, keyId, requests, createdAt: new Date().toISOString() };
        // No consuming request is allowed until all unblinding secrets are durable.
        await this.pendingStore.put(record);
        return record;
    }

    async finish(record, scope, progress) {
        await this.assertScope(scope);
        if (record.needsNewIssuer) record = await this.prepare(record.code, scope, progress);
        const requests = record.requests;
        if (!record.response) {
            progress?.('Redeeming saved code…', 65);
            const body = buildTicketIssuanceRequest(record.code, requests.map(item => [item.index, item.blindedRequest]), record.keyId);
            try {
                record.response = await this.submit(body, requests.length);
            } catch (error) {
                if (error.code === 'TICKET_KEY_CHANGED') {
                    // Preserve the bearer code even if this page closes before
                    // a replacement batch is ready. Old-key signatures are invalid.
                    await this.pendingStore.put({ scope: record.scope, code: record.code, needsNewIssuer: true });
                } else if (error.code === 'CODE_REDEEM_REQUEST_MISMATCH' ||
                    (error.status === 400 && /not found|expired|already (?:used|redeemed)/i.test(error.message))) {
                    // Definitive unusable codes cannot become recoverable by
                    // retrying. Keep ambiguous transport/reservation errors.
                    await this.pendingStore.delete(record);
                }
                throw error;
            }
            validateResponse(record);
            // Persist the response too: recovery after unblinding starts needs no network.
            await this.pendingStore.put(record);
        }
        const responses = validateResponse(record);
        const responseMap = new Map(responses);
        const tickets = [];
        for (const item of requests) {
            if (!responseMap.has(item.index)) throw new Error('The server returned mismatched ticket indexes.');
            const signed = responseMap.get(item.index);
            const finalized = await this.privacyPass.finalizeToken(signed, item.serializedState);
            tickets.push({ blinded_request: item.blindedRequest, signed_response: signed, finalized_ticket: finalized,
                ticket_key_id: record.keyId, created_at: record.createdAt });
            progress?.(`Finishing tickets… (${tickets.length}/${requests.length})`, 67 + Math.round(tickets.length / requests.length * 30));
            if (tickets.length % 8 === 0) await yieldToUI();
        }
        await this.assertScope(scope);
        await this.ticketStore.addTickets(tickets, { requireDurable: true, allowPreviouslyRemoved: true, expectedAccountId: scope.accountId });
        // A crash here only reimports the exact same tokens. The wallet deduplicates
        // active/archive tokens and honors transfer/deletion tombstones.
        await this.pendingStore.delete(record);
        progress?.('Code redeemed!', 100);
        return { success: true, tickets_issued: tickets.length, expires_at: record.response.expires_at };
    }
}
