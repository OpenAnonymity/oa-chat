// Trusted zkAPI server time for new request timestamps, quote and lease checks on the pinned SDK.
// Mirrors zkapi sdk/services/zkapiServerClock.mjs; legacy servers (404/405 on /v2/time) keep the device clock.
export default {
    "name": "server-time-v1",
    "revision": "3342c95871e8422bb878ad40072687c241a68a5b",
    "files": [
        {
            "file": "sdk/services/browserWalletRuntime.js",
            "beforeSha256": "09cf761c7071cf1fe2e4f9724cb038878c7fa9bb4a5cbdd6f06afbdcad56dc08",
            "afterSha256": "c08c74f466e15640202acba13e52a2fb593b567ff9ffaea13397010b987c4e01",
            "replacements": [
                {
                    "before": "const MIN_REQUEST_LEASE_REMAINING_SECONDS = 90;\n",
                    "after": "const MIN_REQUEST_LEASE_REMAINING_SECONDS = 90;\n// New request timestamps and quote checks use a server-clock sample no older\n// than this; lease checks inside one acquisition may reuse a slightly older one.\nconst SERVER_TIME_REQUEST_MAX_AGE_MS = 30_000;\nconst SERVER_TIME_LEASE_CHECK_MAX_AGE_MS = 60_000;\nconst SERVER_TIME_REUSE_MAX_AGE_MS = 5 * 60_000;\nconst FRESHNESS_REJECTION = 'request_time is outside the accepted freshness window';\n"
                },
                {
                    "before": "\nclass BrowserWalletHttpError extends Error {",
                    "after": "\n// Trusted zkAPI server clock for new request timestamps and lease checks.\n// GET /v2/time is additive: a server without it answers 404/405, and only that\n// definite absence selects the legacy device clock. Authentication failures,\n// other HTTP errors, malformed bodies, slow samples and transport failures\n// never downgrade. Observations live in memory for one runtime/deployment only.\nconst SERVER_TIME_SAMPLE_TIMEOUT_MS = 10_000;\nconst SERVER_TIME_MAX_ROUND_TRIP_MS = 5_000;\n// A wall-clock change or an OS suspend that pauses performance.now() shows up\n// as elapsed wall time disagreeing with elapsed monotonic time.\nconst SERVER_TIME_MAX_DISCONTINUITY_MS = 2_000;\n// Three uses, deliberately distinct:\n// - nowMs(): authoritative for authorization; resamples a suspect, aged or\n//   discontinuous anchor and never falls back after a failed sample.\n// - authorizationNowMs(): strict synchronous check inside one authorization\n//   (host callbacks, checkout); fails closed with Infinity.\n// - estimateMs(): display and settlement timers only; never authorizes.\nconst SERVER_TIME_ESTIMATE_MAX_AGE_MS = 15 * 60_000;\nconst SERVER_TIME_MIN_MS = Date.UTC(2024, 0, 1);\nconst SERVER_TIME_MAX_MS = Date.UTC(2200, 0, 1);\nconst SERVER_TIME_MAX_WINDOW_SECONDS = 3_600;\n\nclass ZkapiServerTimeError extends Error {\n    constructor(message, { status = null, retrySample = false, cause } = {}) {\n        super(message, cause ? { cause } : undefined);\n        this.name = 'ZkapiServerTimeError';\n        this.code = 'server_time_unavailable';\n        this.status = status;\n        this.retrySample = retrySample;\n    }\n}\n\nfunction serverTimeWindowSeconds(value) {\n    return Number.isSafeInteger(value) && value > 0 && value <= SERVER_TIME_MAX_WINDOW_SECONDS;\n}\n\nclass ZkapiServerClock {\n    #anchor = null;\n    #suspect = false;\n    #refresh = null;\n\n    constructor({ baseUrl, chainId, fetch, monotonicNow = () => performance.now(), wallNow = () => Date.now() }) {\n        if (typeof fetch !== 'function') throw new TypeError('A server-time fetch function is required.');\n        this.url = new URL('v2/time', `${String(baseUrl).replace(/\\/+$/, '')}/`).href;\n        this.chainId = Number(chainId);\n        this.fetch = fetch;\n        this.monotonicNow = monotonicNow;\n        this.wallNow = wallNow;\n        this.mode = 'unknown';\n    }\n\n    // Lifecycle events can follow a suspend: the next nowMs() resamples. A\n    // strict synchronous check relies on discontinuity detection instead.\n    attachLifecycle(win = globalThis.window, doc = globalThis.document) {\n        const invalidate = () => this.invalidate();\n        doc?.addEventListener?.('resume', invalidate);\n        doc?.addEventListener?.('visibilitychange', () => {\n            if (doc.visibilityState === 'visible') invalidate();\n        });\n        win?.addEventListener?.('pageshow', event => { if (event?.persisted) invalidate(); });\n        win?.addEventListener?.('online', invalidate);\n    }\n\n    invalidate() {\n        this.#suspect = true;\n    }\n\n    #elapsed(anchor) {\n        const elapsed = this.monotonicNow() - anchor.monotonicAt;\n        const wallElapsed = this.wallNow() - anchor.wallAt;\n        if (!Number.isFinite(elapsed) || elapsed < 0) return null;\n        return { elapsed, continuous: Math.abs(wallElapsed - elapsed) <= SERVER_TIME_MAX_DISCONTINUITY_MS };\n    }\n\n    // The sample's server time was produced before the response arrived, so\n    // anchoring it at arrival is a lower bound: estimates never run ahead of\n    // the server and cannot create a future-dated request.\n    #validEstimate(maxAgeMs) {\n        if (this.mode !== 'server' || !this.#anchor || this.#suspect) return null;\n        const elapsed = this.#elapsed(this.#anchor);\n        if (!elapsed?.continuous || elapsed.elapsed > maxAgeMs) {\n            this.#suspect = true;\n            return null;\n        }\n        return this.#anchor.serverMs + Math.floor(elapsed.elapsed);\n    }\n\n    async sample(signal = null) {\n        signal?.throwIfAborted?.();\n        const timeout = AbortSignal.timeout(SERVER_TIME_SAMPLE_TIMEOUT_MS);\n        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;\n        const monotonicStart = this.monotonicNow();\n        const wallStart = this.wallNow();\n        let response;\n        let body;\n        try {\n            response = await this.fetch(this.url, {\n                method: 'GET', cache: 'no-store', credentials: 'omit',\n                headers: { accept: 'application/json' }, signal: requestSignal\n            });\n            if (response.status === 404 || response.status === 405) {\n                // Endpoint absence is the only legacy signal (rolling upgrade).\n                this.#anchor = null;\n                this.#suspect = false;\n                this.mode = 'legacy';\n                return null;\n            }\n            if (!response.ok) {\n                throw new ZkapiServerTimeError(`The zkAPI server clock is unavailable (HTTP ${response.status}).`,\n                    { status: response.status });\n            }\n            body = await response.json();\n        } catch (error) {\n            signal?.throwIfAborted?.();\n            if (error instanceof ZkapiServerTimeError || error?.code === 'testnet_password_required') throw error;\n            throw new ZkapiServerTimeError('The zkAPI server clock could not be read. Check your connection and try again.',\n                { cause: error });\n        }\n        const monotonicAt = this.monotonicNow();\n        const wallAt = this.wallNow();\n        const roundTrip = monotonicAt - monotonicStart;\n        if (!Number.isFinite(roundTrip) || roundTrip < 0 || roundTrip > SERVER_TIME_MAX_ROUND_TRIP_MS) {\n            throw new ZkapiServerTimeError('The zkAPI server clock answered too slowly. Try again.', { retrySample: true });\n        }\n        if (Math.abs((wallAt - wallStart) - roundTrip) > SERVER_TIME_MAX_DISCONTINUITY_MS) {\n            throw new ZkapiServerTimeError('The device clock changed while checking the zkAPI server clock. Try again.',\n                { retrySample: true });\n        }\n        const serverMs = body?.server_time_ms;\n        if (!body || typeof body !== 'object' || Array.isArray(body)\n            || !Number.isSafeInteger(serverMs) || serverMs < SERVER_TIME_MIN_MS || serverMs > SERVER_TIME_MAX_MS\n            || body.chain_id !== this.chainId\n            || !serverTimeWindowSeconds(body.max_request_age_seconds)\n            || !serverTimeWindowSeconds(body.max_future_skew_seconds)) {\n            throw new ZkapiServerTimeError('The zkAPI server returned an invalid clock response.');\n        }\n        this.#anchor = { serverMs, monotonicAt, wallAt };\n        this.#suspect = false;\n        this.mode = 'server';\n        return serverMs;\n    }\n\n    /** Server milliseconds for authorization, sampled when the anchor is older\n     * than maxAgeMs or discontinuous. Legacy servers return the device clock. */\n    async nowMs({ signal = null, maxAgeMs = 30_000 } = {}) {\n        const current = this.#validEstimate(maxAgeMs);\n        if (current != null) return current;\n        for (let attempt = 0; ; attempt += 1) {\n            try {\n                await this.sample(signal);\n                break;\n            } catch (error) {\n                if (!error?.retrySample || attempt >= 1) throw error;\n            }\n        }\n        if (this.mode === 'legacy') return this.wallNow();\n        const sampled = this.#validEstimate(Number.POSITIVE_INFINITY);\n        if (sampled == null) throw new ZkapiServerTimeError('The device clock changed while checking the zkAPI server clock. Try again.');\n        return sampled;\n    }\n\n    /** Best available non-authorizing estimate, or null before any sample.\n     * A suspect anchor schedules one background resample. */\n    estimateMs() {\n        if (this.mode === 'legacy') return this.wallNow();\n        const valid = this.#validEstimate(SERVER_TIME_ESTIMATE_MAX_AGE_MS);\n        if (valid != null) return valid;\n        if (!this.#anchor) return null;\n        if (!this.#refresh) {\n            this.#refresh = this.sample().catch(() => null).finally(() => { this.#refresh = null; });\n        }\n        const elapsed = this.#elapsed(this.#anchor);\n        return elapsed ? this.#anchor.serverMs + Math.floor(elapsed.elapsed) : null;\n    }\n\n    /** Strict synchronous check for callbacks inside one authorization. Any\n     * wall/monotonic discontinuity (OS suspend or clock change) since the\n     * anchor, an anchor older than maxAgeMs, or no anchor fails closed with\n     * Infinity, so an expiry comparison treats the key as expired. */\n    authorizationNowMs(maxAgeMs = 60_000) {\n        if (this.mode === 'legacy') return this.wallNow();\n        if (this.mode !== 'server' || !this.#anchor) return Number.POSITIVE_INFINITY;\n        const elapsed = this.#elapsed(this.#anchor);\n        if (!elapsed?.continuous || elapsed.elapsed > maxAgeMs) {\n            this.#suspect = true;\n            return Number.POSITIVE_INFINITY;\n        }\n        return this.#anchor.serverMs + Math.floor(elapsed.elapsed);\n    }\n}\n\nclass BrowserWalletHttpError extends Error {"
                },
                {
                    "before": "            requestPassword: browserSdkOptions().requestTestnetPassword\n        });\n",
                    "after": "            requestPassword: browserSdkOptions().requestTestnetPassword\n        });\n        // Memory only: a new deployment configuration or page load starts a\n        // new clock, and nothing samples it until a new authorization needs it.\n        this.serverClock = new ZkapiServerClock({\n            baseUrl: this.config.funding.protocol_server_url,\n            chainId: this.config.funding.chain_id,\n            fetch: (url, init) => this.serverClockFetch(url, init)\n        });\n        this.serverClock.attachLifecycle();\n"
                },
                {
                    "before": "const active = this.activeLease && this.activeLease.expires_at > Math.floor(Date.now() / 1000)",
                    "after": "const active = this.activeLease && this.activeLease.expires_at > Math.floor(this.protocolEstimateMs() / 1000)"
                },
                {
                    "before": "    async remoteFetchRaw(url, init = {}) {\n        const proxyUrl = this.deploymentProxyUrl(url);\n        if (proxyUrl) {\n            try {\n                const response = await fetch(proxyUrl, {\n                    ...init,\n                    credentials: 'omit'\n                });\n                if (response.status !== 404) return response;",
                    "after": "    async remoteFetchRaw(url, init = {}) {\n        const { zkapiAuthoritativeProxy = false, ...request } = init;\n        init = request;\n        const proxyUrl = this.deploymentProxyUrl(url);\n        if (proxyUrl) {\n            try {\n                const response = await fetch(proxyUrl, {\n                    ...init,\n                    credentials: 'omit'\n                });\n                // The production rewrite forwards the deployment's own status.\n                // A server-time 404 there means an older server, not a missing\n                // rewrite, so it must not fall through to a direct request.\n                if (response.status !== 404 || zkapiAuthoritativeProxy) return response;"
                },
                {
                    "before": "    async remoteJson(url, init = {}) {\n        const response = await this.remoteFetch(url, init);",
                    "after": "    async serverClockFetch(url, init = {}) {\n        const response = await this.remoteFetch(url, { ...init, zkapiAuthoritativeProxy: true });\n        if (response.status === 401 && this.testnetAuth?.protects(url)) throw testnetPasswordRequired();\n        return response;\n    }\n\n    /** Server milliseconds. New authorizations pass required: true and never\n     * fall back after a failed sample; other checks may use the best estimate. */\n    async protocolTimeMs(signal = null, { required = false, maxAgeMs = SERVER_TIME_LEASE_CHECK_MAX_AGE_MS } = {}) {\n        if (!this.serverClock) return Date.now();\n        try {\n            return await this.serverClock.nowMs({ signal, maxAgeMs });\n        } catch (error) {\n            if (required || signal?.aborted || error?.name === 'AbortError') throw error;\n            return this.serverClock.estimateMs() ?? Date.now();\n        }\n    }\n\n    protocolEstimateMs() {\n        return this.serverClock?.estimateMs() ?? Date.now();\n    }\n\n    async remoteJson(url, init = {}) {\n        const response = await this.remoteFetch(url, init);"
                },
                {
                    "before": "    async nativeBillingQuote(signal) {\n        const funding = this.config.funding;\n        const quoted = await this.remoteJson(`${funding.protocol_server_url}/v2/billing/quote`, { signal });\n        validateNativeQuote(quoted, funding);\n        const verified = await readNativeQuote(funding, { expected: quoted, signal });",
                    "after": "    async nativeBillingQuote(signal) {\n        const funding = this.config.funding;\n        const quoted = await this.remoteJson(`${funding.protocol_server_url}/v2/billing/quote`, { signal });\n        const now = Math.floor(await this.protocolTimeMs(signal, {\n            required: true, maxAgeMs: SERVER_TIME_REQUEST_MAX_AGE_MS\n        }) / 1000);\n        validateNativeQuote(quoted, funding, { now });\n        const verified = await readNativeQuote(funding, { expected: quoted, signal, now });"
                },
                {
                    "before": "    leaseBudget(spendingLimitUsd, quote = null, { checkBalance = false } = {}) {",
                    "after": "    leaseBudget(spendingLimitUsd, quote = null, { checkBalance = false, now } = {}) {"
                },
                {
                    "before": "        validateNativeQuote(quote, this.config.funding, { allowExpired: true });\n        const amount = Number(nativeUnitsForUsd(spendingLimitUsd, quote));",
                    "after": "        validateNativeQuote(quote, this.config.funding, { allowExpired: true, ...(now == null ? {} : { now }) });\n        const amount = Number(nativeUnitsForUsd(spendingLimitUsd, quote));"
                },
                {
                    "before": "        onProgress('syncing', 'Checking your private balance…');\n        const path = await this.treePath(this.runtime.state.note_id, true);\n        throwIfAborted(signal);\n        const now = Date.now();\n        const quote = isNativeEthFunding(this.config.funding) ? await this.nativeBillingQuote(signal) : null;\n        throwIfAborted(signal);\n        const spendingLimitCredits = this.leaseBudget(spendingLimitUsd, quote, { checkBalance: true });\n        onProgress('proving', 'Proving this chat is funded…');",
                    "after": "        onProgress('syncing', 'Checking your private balance…');\n        // Load the request prover before choosing request_time, so a slow\n        // proving-key download cannot consume the server's admission window.\n        const warmup = this.prewarmRequestProver();\n        const path = await this.treePath(this.runtime.state.note_id, true);\n        throwIfAborted(signal);\n        await waitUnlessAborted(warmup, signal);\n        throwIfAborted(signal);\n        const quote = isNativeEthFunding(this.config.funding) ? await this.nativeBillingQuote(signal) : null;\n        throwIfAborted(signal);\n        const quoteCheckedAt = Math.floor(await this.protocolTimeMs(signal, {\n            required: true, maxAgeMs: SERVER_TIME_REQUEST_MAX_AGE_MS\n        }) / 1000);\n        const spendingLimitCredits = this.leaseBudget(spendingLimitUsd, quote, { checkBalance: true, now: quoteCheckedAt });\n        // Select the public timestamp last, from a bounded server sample.\n        const requestTimeMs = await this.protocolTimeMs(signal, {\n            required: true, maxAgeMs: SERVER_TIME_REQUEST_MAX_AGE_MS\n        });\n        throwIfAborted(signal);\n        const createdAtMs = Date.now();\n        onProgress('proving', 'Proving this chat is funded…');"
                },
                {
                    "before": "                request_time: Math.floor(now / 1000),\n                created_at_ms: now",
                    "after": "                request_time: Math.floor(requestTimeMs / 1000),\n                created_at_ms: createdAtMs"
                },
                {
                    "before": "        throwIfAborted(signal);\n        if (lease.status !== 'active'\n            || lease.client_request_id !== expectedRequestId\n            || !lease.api_key\n            || Number(lease.expires_at) <= Math.floor(Date.now() / 1000)) {",
                    "after": "        throwIfAborted(signal);\n        const checkedAt = Math.floor(await this.protocolTimeMs(signal) / 1000);\n        throwIfAborted(signal);\n        if (lease.status !== 'active'\n            || lease.client_request_id !== expectedRequestId\n            || !lease.api_key\n            || Number(lease.expires_at) <= checkedAt) {"
                },
                {
                    "before": "        if (isNativeEthFunding(this.config.funding)) {\n            validateNativeQuote(expectedQuote, this.config.funding, { allowExpired: true });",
                    "after": "        if (isNativeEthFunding(this.config.funding)) {\n            validateNativeQuote(expectedQuote, this.config.funding, { allowExpired: true, now: checkedAt });"
                },
                {
                    "before": "                        recentlyAttested: evidence.station_recently_attested === true\n                    },\n                    signal\n                })",
                    "after": "                        recentlyAttested: evidence.station_recently_attested === true\n                    },\n                    signal,\n                    now: () => this.protocolEstimateMs()\n                })"
                },
                {
                    "before": "        browserSdkOptions().assertProviderKey?.({\n            station_id: lease.verification?.station_id || null,\n            verifierSubmitKeyProof: lease.verifierSubmitKeyProof || null\n        });",
                    "after": "        browserSdkOptions().assertProviderKey?.({\n            station_id: lease.verification?.station_id || null,\n            verifierSubmitKeyProof: lease.verifierSubmitKeyProof || null\n        }, { now: () => this.protocolEstimateMs() });"
                },
                {
                    "before": "            if (['native_quote_expired', 'native_quote_superseded'].includes(error?.code) && isNativeEthFunding(this.config.funding)) {\n                await this.recoverUnacceptedNativeQuote(request, signal);\n            }\n            throw error;",
                    "after": "            if (['native_quote_expired', 'native_quote_superseded'].includes(error?.code) && isNativeEthFunding(this.config.funding)) {\n                await this.recoverUnacceptedNativeQuote(request, signal);\n            } else if (isFreshnessRejection(error) && isNativeEthFunding(this.config.funding)) {\n                // Keep the admission error; a failed check leaves the journal.\n                try { await this.recoverUnacceptedNativeQuote(request, signal); }\n                catch (recoveryError) { if (signal?.aborted) throw recoveryError; }\n            }\n            throw error;"
                },
                {
                    "before": "            const desiredLimitCredits = this.leaseBudget(spendingLimitUsd, requestBillingQuote(request));",
                    "after": "            const desiredLimitCredits = this.leaseBudget(spendingLimitUsd, requestBillingQuote(request), {\n                now: Math.floor(await this.protocolTimeMs(signal) / 1000)\n            });"
                },
                {
                    "before": "        if (this.leasePromise) {\n            return this.waitForLeasePromise(normalized, onProgress, signal, spendingLimitUsd);\n        }\n        const now = Math.floor(Date.now() / 1000);",
                    "after": "        // Await before the synchronous lease-promise section below, so no\n        // concurrent caller can start a second issuance in between.\n        const now = Math.floor(await this.protocolTimeMs(signal, { maxAgeMs: SERVER_TIME_REUSE_MAX_AGE_MS }) / 1000);\n        throwIfAborted(signal);\n        if (this.leasePromise) {\n            return this.waitForLeasePromise(normalized, onProgress, signal, spendingLimitUsd);\n        }"
                },
                {
                    "before": "            Number(this.activeLease.settle_after) * 1000 - Date.now() + 250",
                    "after": "            Number(this.activeLease.settle_after) * 1000 - this.protocolEstimateMs() + 250"
                },
                {
                    "before": "                    && Number(lease.settle_after) * 1000 <= Date.now()) {",
                    "after": "                    && Number(lease.settle_after) * 1000 <= this.protocolEstimateMs()) {"
                },
                {
                    "before": "            if (status.status === 'active' && retireLostKey) {\n                const ownershipDeadline = Number(\n                    this.runtime.lease?.settle_after || this.runtime.lease?.expires_at\n                );\n                if (this.runtime.lease && ownershipDeadline > Math.floor(Date.now() / 1000)",
                    "after": "            if (status.status === 'active' && retireLostKey) {\n                const ownershipDeadline = Number(\n                    this.runtime.lease?.settle_after || this.runtime.lease?.expires_at\n                );\n                const ownershipNow = Math.floor(await this.protocolTimeMs(signal) / 1000);\n                if (this.runtime.lease && ownershipDeadline > ownershipNow"
                },
                {
                    "before": "            || body !== JSON.stringify(journal?.prepared_request)) return false;\n        validateNativeQuote(requestBillingQuote(request), this.config.funding, { allowExpired: true });",
                    "after": "            || body !== JSON.stringify(journal?.prepared_request)) return false;\n        validateNativeQuote(requestBillingQuote(request), this.config.funding, {\n            allowExpired: true, now: Math.floor(await this.protocolTimeMs(signal) / 1000)\n        });"
                },
                {
                    "before": "            const quote = requestBillingQuote(this.runtime.journal?.prepared_request);\n            validateNativeQuote(quote, this.config.funding, { allowExpired: true });",
                    "after": "            const quote = requestBillingQuote(this.runtime.journal?.prepared_request);\n            validateNativeQuote(quote, this.config.funding, {\n                allowExpired: true, now: Math.floor(await this.protocolTimeMs() / 1000)\n            });"
                },
                {
                    "before": "\nclass BrowserWalletHttpError extends Error {",
                    "after": "\nfunction isFreshnessRejection(error) {\n    return error?.code === 'invalid_request' && String(error?.message || '').includes(FRESHNESS_REJECTION);\n}\n\nfunction waitUnlessAborted(promise, signal) {\n    if (!signal) return promise;\n    return new Promise((resolve, reject) => {\n        const abort = () => reject(signal.reason || new DOMException('The operation was aborted.', 'AbortError'));\n        if (signal.aborted) return abort();\n        signal.addEventListener('abort', abort, { once: true });\n        promise.then(resolve, resolve).finally(() => signal.removeEventListener('abort', abort));\n    });\n}\n\nclass BrowserWalletHttpError extends Error {"
                },
                {
                    "before": "now: Math.floor(await this.protocolTimeMs(signal) / 1000)\n            });\n            if (Number(request.public_inputs.solvency_bound)",
                    "after": "now: Math.floor((this.serverClock ? await this.protocolTimeMs(signal) : Date.now()) / 1000)\n            });\n            if (Number(request.public_inputs.solvency_bound)"
                },
                {
                    "before": "const ownershipNow = Math.floor(await this.protocolTimeMs(signal) / 1000);",
                    "after": "const ownershipNow = Math.floor((this.serverClock ? await this.protocolTimeMs(signal) : Date.now()) / 1000);"
                },
                {
                    "before": "allowExpired: true, now: Math.floor(await this.protocolTimeMs(signal) / 1000)\n        });",
                    "after": "allowExpired: true, now: Math.floor((this.serverClock ? await this.protocolTimeMs(signal) : Date.now()) / 1000)\n        });"
                },
                {
                    "before": "allowExpired: true, now: Math.floor(await this.protocolTimeMs() / 1000)",
                    "after": "allowExpired: true, now: Math.floor((this.serverClock ? await this.protocolTimeMs() : Date.now()) / 1000)"
                },
                {
                    "before": "const checkedAt = Math.floor(await this.protocolTimeMs(signal) / 1000);",
                    "after": "const checkedAt = Math.floor((this.serverClock ? await this.protocolTimeMs(signal) : Date.now()) / 1000);"
                },
                {
                    "before": "const now = Math.floor(await this.protocolTimeMs(signal, { maxAgeMs: SERVER_TIME_REUSE_MAX_AGE_MS }) / 1000);",
                    "after": "const now = Math.floor((this.serverClock\n            ? await this.protocolTimeMs(signal, { maxAgeMs: SERVER_TIME_REUSE_MAX_AGE_MS })\n            : Date.now()) / 1000);"
                },
                {
                    "before": "    async protocolTimeMs(signal = null,",
                    "after": "    // Callers skip this await when no clock exists (an uninitialized runtime),\n    // so that legacy path stays synchronous and byte-for-byte equivalent.\n    async protocolTimeMs(signal = null,"
                },
                {
                    "before": "        // Memory only: a new deployment configuration or page load starts a\n        // new clock, and nothing samples it until a new authorization needs it.\n        this.serverClock = new ZkapiServerClock({\n            baseUrl: this.config.funding.protocol_server_url,\n            chainId: this.config.funding.chain_id,\n            fetch: (url, init) => this.serverClockFetch(url, init)\n        });\n        this.serverClock.attachLifecycle();\n",
                    "after": "        this.installServerClock();\n"
                },
                {
                    "before": "    async serverClockFetch(url, init = {}) {",
                    "after": "    // Memory only: a new deployment configuration or page load starts a new\n    // clock, and nothing samples it until a new authorization needs it.\n    installServerClock({ monotonicNow, wallNow, lifecycle = true } = {}) {\n        this.serverClock = new ZkapiServerClock({\n            baseUrl: this.config.funding.protocol_server_url,\n            chainId: this.config.funding.chain_id,\n            fetch: (url, init) => this.serverClockFetch(url, init),\n            ...(monotonicNow ? { monotonicNow } : {}),\n            ...(wallNow ? { wallNow } : {})\n        });\n        if (lifecycle) this.serverClock.attachLifecycle();\n        return this.serverClock;\n    }\n\n    async serverClockFetch(url, init = {}) {"
                },
                {
                    "before": "    protocolEstimateMs() {\n        return this.serverClock?.estimateMs() ?? Date.now();\n    }\n",
                    "after": "    // Display and settlement timers only; never authorizes a key.\n    protocolEstimateMs() {\n        return this.serverClock?.estimateMs() ?? Date.now();\n    }\n\n    // Strict synchronous authorization time (host callbacks, checkout): fails\n    // closed (Infinity) after a suspend or clock change, or an aged anchor.\n    protocolAuthorizationNowMs(maxAgeMs = SERVER_TIME_LEASE_CHECK_MAX_AGE_MS) {\n        return this.serverClock ? this.serverClock.authorizationNowMs(maxAgeMs) : Date.now();\n    }\n"
                },
                {
                    "before": "        }\n    }\n\n    async requestLeaseWithRetry(",
                    "after": "        }\n        // Verification is asynchronous and the device may have slept during\n        // it. Recheck with a bounded fresh server sample before the key can be\n        // installed; a failure leaves the exact journal for recovery and never\n        // starts a second authorization by itself.\n        const verifiedAt = Math.floor((this.serverClock\n            ? await this.protocolTimeMs(signal, { required: true, maxAgeMs: SERVER_TIME_LEASE_CHECK_MAX_AGE_MS })\n            : Date.now()) / 1000);\n        throwIfAborted(signal);\n        const evidenceExpiry = lease.verification?.key_valid_till;\n        if (Number(lease.expires_at) <= verifiedAt\n            || (evidenceExpiry != null && Number(evidenceExpiry) <= verifiedAt)) {\n            throw new BrowserWalletHttpError('The new private key expired before it could be verified. Send again to finish it safely.',\n                409, 'lease_expired');\n        }\n    }\n\n    async requestLeaseWithRetry("
                },
                {
                    "before": "            ? await this.protocolTimeMs(signal, { maxAgeMs: SERVER_TIME_REUSE_MAX_AGE_MS })",
                    "after": "            ? await this.protocolTimeMs(signal, { required: true, maxAgeMs: SERVER_TIME_REUSE_MAX_AGE_MS })"
                },
                {
                    "before": "        if (this.activeLease !== lease || lease.retiring || lease.retired) {\n            throw new BrowserWalletHttpError(\n                'The previous private key is closing. Retry when its balance update finishes.',\n                409,\n                'lease_pending'\n            );\n        }\n",
                    "after": "        if (this.activeLease !== lease || lease.retiring || lease.retired) {\n            throw new BrowserWalletHttpError(\n                'The previous private key is closing. Retry when its balance update finishes.',\n                409,\n                'lease_pending'\n            );\n        }\n        if (Number(lease.expires_at) * 1000 <= this.protocolAuthorizationNowMs(SERVER_TIME_REUSE_MAX_AGE_MS)) {\n            throw new BrowserWalletHttpError('This private key has expired. Send again to continue.', 409, 'lease_expired');\n        }\n"
                },
                {
                    "before": "                    signal,\n                    now: () => this.protocolEstimateMs()\n                })",
                    "after": "                    signal,\n                    // Strict synchronous time, plus a bounded authoritative\n                    // resample the host may await after its own async work.\n                    now: () => this.protocolAuthorizationNowMs(),\n                    refreshNow: () => this.protocolTimeMs(signal, {\n                        required: true, maxAgeMs: SERVER_TIME_LEASE_CHECK_MAX_AGE_MS\n                    })\n                })"
                },
                {
                    "before": "        }, { now: () => this.protocolEstimateMs() });",
                    "after": "        }, { now: () => this.protocolAuthorizationNowMs(SERVER_TIME_REUSE_MAX_AGE_MS) });"
                },
                {
                    "before": "\nfunction isFreshnessRejection(error) {",
                    "after": "\n// A saved request's quote was strictly validated when it was proved. Recovery\n// and receipt installation re-check only its structure and deployment\n// binding: the server's exact /expire answer or signed receipt decides its\n// fate, never the device clock or a /v2/time sample.\nfunction validateSavedNativeQuote(quote, funding) {\n    return validateNativeQuote(quote, funding, { allowExpired: true, now: Number.MAX_SAFE_INTEGER });\n}\n\nfunction isFreshnessRejection(error) {"
                },
                {
                    "before": "    leaseBudget(spendingLimitUsd, quote = null, { checkBalance = false, now } = {}) {",
                    "after": "    leaseBudget(spendingLimitUsd, quote = null, { checkBalance = false, now, saved = false } = {}) {"
                },
                {
                    "before": "        validateNativeQuote(quote, this.config.funding, { allowExpired: true, ...(now == null ? {} : { now }) });",
                    "after": "        if (saved) validateSavedNativeQuote(quote, this.config.funding);\n        else validateNativeQuote(quote, this.config.funding, { allowExpired: true, ...(now == null ? {} : { now }) });"
                },
                {
                    "before": "            const desiredLimitCredits = this.leaseBudget(spendingLimitUsd, requestBillingQuote(request), {\n                now: Math.floor((this.serverClock ? await this.protocolTimeMs(signal) : Date.now()) / 1000)\n            });",
                    "after": "            const desiredLimitCredits = this.leaseBudget(spendingLimitUsd, requestBillingQuote(request), { saved: true });"
                },
                {
                    "before": "validateNativeQuote(expectedQuote, this.config.funding, { allowExpired: true, now: checkedAt });",
                    "after": "validateSavedNativeQuote(expectedQuote, this.config.funding);"
                },
                {
                    "before": "validateNativeQuote(quote, this.config.funding, {\n                allowExpired: true, now: Math.floor((this.serverClock ? await this.protocolTimeMs() : Date.now()) / 1000)\n            });",
                    "after": "validateSavedNativeQuote(quote, this.config.funding); // The signed receipt must bind this exact quote."
                },
                {
                    "before": "        validateNativeQuote(requestBillingQuote(request), this.config.funding, {\n            allowExpired: true, now: Math.floor((this.serverClock ? await this.protocolTimeMs(signal) : Date.now()) / 1000)\n        });",
                    "after": "        validateSavedNativeQuote(requestBillingQuote(request), this.config.funding);"
                }
            ]
        },
        {
            "file": "sdk/services/zkapiNativeEth.mjs",
            "beforeSha256": "83a99571e894f326f7257a4d5cb09c87527a863f1eb3d93ca14f6e0c02a72d84",
            "afterSha256": "d54b29f80aaaa85cfe6882a21d8526332cc87a64a9735dba394979e902d7833e",
            "replacements": [
                {
                    "before": "export async function readNativeQuote(funding, { expected = null, signal = AbortSignal.timeout(20_000) } = {}) {\n    validateNativeFunding(funding);\n    if (expected) validateNativeQuote(expected, funding);",
                    "after": "export async function readNativeQuote(funding, { expected = null, signal = AbortSignal.timeout(20_000), now } = {}) {\n    validateNativeFunding(funding);\n    // Callers on the lease path pass trusted server seconds; others keep the device clock.\n    const timing = now == null ? {} : { now };\n    if (expected) validateNativeQuote(expected, funding, timing);"
                },
                {
                    "before": "updated_at: Number(updated), expires_at: Number(updated) + funding.native_price_max_age_seconds }, funding);",
                    "after": "updated_at: Number(updated), expires_at: Number(updated) + funding.native_price_max_age_seconds }, funding, timing);"
                }
            ]
        }
    ]
};
