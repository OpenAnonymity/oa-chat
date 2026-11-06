// Local fake zkAPI deployment for server-clock tests. It applies the deployed
// server's admission rules (request_time in [now - 300, now + 30], quote
// expiry, unaccepted-age /expire) against its own clock, while the device
// wall clock and the monotonic clock are independently controllable.
const HASH = `0x${'44'.repeat(32)}`;
const word = value => BigInt(value).toString(16).padStart(64, '0');

export function createServerTimeWorld({ funding, skewMs = 0, timeEndpoint = 'v2', inferenceBase = 'https://openrouter.ai/api/v1' } = {}) {
    const world = {
        serverMs: Date.UTC(2026, 10, 6, 12, 0, 0),
        monotonicMs: 50_000,
        skewMs,
        timeEndpoint, // 'v2' | 404 | 405 | 401 | 403 | 500 | 'malformed' | 'network' | 'slow'
        // Milliseconds the fake server spends before and after reading its clock.
        latencyBeforeMs: 20,
        latencyAfterMs: 20,
        timeRequests: [],
        leasePosts: [],
        expireCalls: [],
        acceptedRequests: new Map(),
        log: [],
        quoteAgeSeconds: 120,
        onTimeRequest: null,
        advance(ms) { this.monotonicMs += ms; this.serverMs += ms; },
        // OS sleep where performance.now() pauses: wall and server time move on.
        suspend(ms) { this.serverMs += ms; },
        jumpDevice(ms) { this.skewMs += ms; },
        deviceNow() { return this.serverMs + this.skewMs; },
        serverSeconds() { return Math.floor(this.serverMs / 1000); }
    };
    world.quote = () => {
        const updated = world.serverSeconds() - world.quoteAgeSeconds;
        world.currentQuote ||= { asset: 'native_eth', units_per_eth: 1_000_000_000, chain_id: funding.chain_id,
            feed_address: funding.native_price_feed_address.toLowerCase(), round_id: '123', answer: '100000000000',
            decimals: 8, updated_at: updated, expires_at: updated + funding.native_price_max_age_seconds };
        return world.currentQuote;
    };
    const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
        status, headers: { 'content-type': 'application/json', ...headers }
    });
    const errorBody = (status, code, message) => json({ status: 'error', error_code: code, error_message: message,
        retriable: false, server_time_ms: world.serverMs }, status);

    function timeResponse(init) {
        world.timeRequests.push({ init, deviceMs: world.deviceNow() });
        world.onTimeRequest?.(world);
        const mode = world.timeEndpoint;
        if (mode === 'network') throw new TypeError('Failed to fetch');
        if (typeof mode === 'number') return json({ error: 'status' }, mode);
        world.advance(world.latencyBeforeMs);
        const body = mode === 'malformed' ? { server_time_ms: String(world.serverMs) }
            : typeof mode === 'object' ? mode
                : { server_time_ms: world.serverMs, protocol_version: 2, chain_id: funding.chain_id,
                    max_request_age_seconds: 300, max_future_skew_seconds: 30 };
        world.advance(mode === 'slow' ? 6_000 : world.latencyAfterMs);
        return json(body, 200, { 'cache-control': 'no-store' });
    }

    function leaseResponse(request) {
        world.leasePosts.push({ request, serverSeconds: world.serverSeconds() });
        const accepted = world.acceptedRequests.get(request.public_inputs.request_nullifier);
        if (accepted) return json(accepted.lease, 201);
        const now = world.serverSeconds();
        const quote = JSON.parse(request.payload).billing_quote;
        if (quote.expires_at <= now) return errorBody(409, 'native_quote_expired', 'native ETH quote expired');
        const time = Number(request.public_inputs.request_time);
        if (time + 300 < now || time > now + 30) {
            return errorBody(400, 'invalid_request', 'invalid request: request_time is outside the accepted freshness window');
        }
        const apiKey = `sk-test-${world.leasePosts.length}`;
        const lease = {
            status: 'active', client_request_id: request.client_request_id, api_key: apiKey,
            issued_at: now, expires_at: now + 600, settle_after: now + 630, valid_for_seconds: 600,
            spending_limit_usd: world.spendingLimitUsd(request), billing_quote: quote,
            openrouter_api_base: inferenceBase, key_source: world.keySource || 'openrouter',
            ...(world.leaseExtras ? world.leaseExtras(now, apiKey) : {})
        };
        world.acceptedRequests.set(request.public_inputs.request_nullifier, { request, lease });
        return json(lease, 201);
    }

    function expireResponse(request) {
        world.expireCalls.push({ request, serverSeconds: world.serverSeconds() });
        if (world.expireFails) return errorBody(503, 'internal_error', 'temporarily unavailable');
        const now = world.serverSeconds();
        if (world.acceptedRequests.has(request.public_inputs.request_nullifier)) {
            return errorBody(409, 'lease_pending', 'lease pending');
        }
        const quote = JSON.parse(request.payload).billing_quote;
        const aged = world.expireKnowsAge !== false && Number(request.public_inputs.request_time) + 300 < now;
        if (quote.expires_at > now && !aged) return errorBody(409, 'lease_pending', 'lease pending');
        return json({ status: 'expired_unaccepted', client_request_id: request.client_request_id,
            request_nullifier: request.public_inputs.request_nullifier, payload_hash: request.payload_hash,
            server_time_ms: world.serverMs }, 200, { 'cache-control': 'no-store' });
    }

    function rpcResponse(init) {
        const { method, params } = JSON.parse(init.body);
        world.onRpc?.(world, method);
        const quote = world.quote();
        const block = { number: '0x123', hash: HASH };
        let result;
        if (method === 'eth_chainId') result = `0x${funding.chain_id.toString(16)}`;
        else if (method === 'eth_getBlockByNumber') result = block;
        else if (method === 'eth_call') {
            const data = params[0].data;
            result = data === '0x4d1352fd' ? `0x${word(1_000_000_000)}`
                : data === '0x631b2f10' ? `0x${word(0)}`
                    : data === '0x313ce567' ? `0x${word(8)}`
                        : `0x${[quote.round_id, quote.answer, quote.updated_at - 1, quote.updated_at, quote.round_id].map(word).join('')}`;
        } else throw new Error(`Unexpected RPC ${method}`);
        return json({ jsonrpc: '2.0', id: 1, result });
    }

    world.fetch = async (input, init = {}) => {
        const url = String(input);
        world.log.push(url);
        if (init.signal?.aborted) throw init.signal.reason;
        const base = funding.protocol_server_url.replace(/\/+$/, '');
        if (url === funding.demo_rpc_url || url === funding.rpc_url) return rpcResponse(init);
        if (url === `${base}/v2/time`) return timeResponse(init);
        if (world.verifierUrl && url === `${world.verifierUrl}/submit_key` && init.method === 'POST') {
            world.verifications = (world.verifications || 0) + 1;
            await world.onVerify?.(world, JSON.parse(init.body));
            return json({ status: 'verified' });
        }
        if (url === `${base}/v2/billing/quote`) return json(world.quote(), 200, { 'cache-control': 'no-store' });
        if (url === `${base}/v2/openrouter/leases` && init.method === 'POST') return leaseResponse(JSON.parse(init.body));
        const expire = url.match(/\/v2\/openrouter\/leases\/([^/]+)\/expire$/);
        if (expire && init.method === 'POST') return expireResponse(JSON.parse(init.body));
        const receipt = url.match(/\/v2\/requests\/([^/]+)$/);
        if (receipt) {
            const response = world.receipts?.get(decodeURIComponent(receipt[1]));
            return response ? json({ status: 'finalized', nullifier_status: 'finalized', request_response: response })
                : errorBody(404, 'not_found', 'not found');
        }
        if (url.startsWith(`${base}/v2/openrouter/leases/`)) return errorBody(404, 'not_found', 'not found');
        if (url.startsWith(`${base}/v2/nullifiers/`)) return json({ status: 'not_found', nullifier_status: 'unknown' });
        throw new Error(`Unexpected request ${url}`);
    };
    return world;
}

/** Prepare a real runtime instance against the fake world. */
export function serverTimeRuntime(BrowserWalletRuntime, world, { funding, openrouter, deploymentId = 'server-time-test' } = {}) {
    const runtime = new BrowserWalletRuntime();
    runtime.config = {
        funding, wallet_core: {}, request_charge_cap: 1_000, credits_per_usd: 1_000_000, policy_enabled: false,
        proving_keys: { request: { url: 'https://assets.example/request.pk', sha256: 'abc' } },
        openrouter: openrouter || { inference_base: 'https://openrouter.ai/api/v1', require_oa_key_source: false }
    };
    runtime.manifest = { deployment_id: deploymentId };
    runtime.runtime = { state: { note_id: 1, current_balance: 50_000_000 } };
    runtime.reload = async () => runtime.runtime;
    runtime.init = async () => runtime;
    runtime.commits = [];
    runtime.commit = async next => { runtime.commits.push(next); runtime.runtime = next; };
    runtime.treePath = async () => ({ active_root: '0x1', siblings: [] });
    runtime.scheduleSettlement = () => {};
    world.proofs = [];
    world.preloads = 0;
    runtime.worker = { call: async (operation, input) => {
        if (operation === 'preloadRequestProver') {
            world.preloads += 1;
            world.advance(world.preloadMs || 0);
            return true;
        }
        if (operation === 'completeResponse') {
            world.completed = [...(world.completed || []), input.args];
            return { ...input.args.state, receipt: input.args.response.response_payload };
        }
        if (operation !== 'prepareRequest') throw new Error(`Unexpected worker call ${operation}`);
        world.advance(world.provingMs || 0);
        const index = world.proofs.length + 1;
        const request = { client_request_id: `request-${index}`, payload_hash: `0x${index.toString(16)}`,
            payload: input.args.payload,
            public_inputs: { request_time: input.args.request_time, request_nullifier: `0x${(0x40 + index).toString(16)}`,
                solvency_bound: input.config.request_charge_cap },
            proof: { backend: 'groth16_bn254', proof: `proof-${index}` } };
        world.proofs.push({ args: input.args, request });
        return { request, journal: { nullifier: request.public_inputs.request_nullifier, prepared_request: request,
            created_at_ms: input.args.created_at_ms } };
    } };
    runtime.installServerClock({ monotonicNow: () => world.monotonicMs, wallNow: () => world.deviceNow(), lifecycle: false });
    return runtime;
}
