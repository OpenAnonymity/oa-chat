// Explicit host verification policy for the pinned SDK; preserves all lease/proof checks.
export default {
    "name": "provider-verification-v1",
    "revision": "3342c95871e8422bb878ad40072687c241a68a5b",
    "files": [
        {
            "file": "sdk/configure.js",
            "beforeSha256": "6e40dd61cd3e0d8256785fecb710dad626fc72f5c2e1cc056a00de294be78bc2",
            "afterSha256": "2859ecab058ece8fb28673ca6485225581cf14d2f289e0abb264d65a3ab89073",
            "replacements": [
                {
                    "before": "requestTestnetPassword: null });",
                    "after": "requestTestnetPassword: null, verifyProviderKey: null, assertProviderKey: null });"
                },
                {
                    "before": "'mode', 'requestTestnetPassword'].includes(key)",
                    "after": "'mode', 'requestTestnetPassword', 'verifyProviderKey', 'assertProviderKey'].includes(key)"
                },
                {
                    "before": "    if (!['browser', 'auto', 'daemon'].includes(merged.mode)) {",
                    "after": "    for (const name of ['verifyProviderKey', 'assertProviderKey']) {\n        if (merged[name] !== null && typeof merged[name] !== 'function') {\n            throw new TypeError(name + ' must be a provider verification function.');\n        }\n    }\n    if (!['browser', 'auto', 'daemon'].includes(merged.mode)) {"
                }
            ]
        },
        {
            "file": "sdk/services/browserWalletRuntime.js",
            "beforeSha256": "cf51ddfdf381e810c4c3322968e3ecbd94976e22e27a9df0847e3827ea69e565",
            "afterSha256": "09cf761c7071cf1fe2e4f9724cb038878c7fa9bb4a5cbdd6f06afbdcad56dc08",
            "replacements": [
                {
                    "before": "            const verification = await this.remoteJson(`${this.config.openrouter.verifier_url}/submit_key`, {\n                method: 'POST',\n                headers: { 'content-type': 'application/json' },\n                signal,\n                body: JSON.stringify({\n                    station_id: evidence.station_id,\n                    api_key: lease.api_key,\n                    key_valid_till: evidence.key_valid_till,\n                    station_signature: evidence.station_signature,\n                    org_signature: evidence.org_signature\n                })\n            });\n            if (verification.status !== 'verified') throw new Error('The trusted OA verifier rejected the ephemeral key.');",
                    "after": "            const hostVerify = browserSdkOptions().verifyProviderKey;\n            const verification = hostVerify\n                ? await hostVerify({\n                    verifierUrl: this.config.openrouter.verifier_url,\n                    keyData: {\n                        stationId: evidence.station_id,\n                        key: lease.api_key,\n                        expiresAtUnix: evidence.key_valid_till,\n                        stationSignature: evidence.station_signature,\n                        orgSignature: evidence.org_signature,\n                        recentlyAttested: evidence.station_recently_attested === true\n                    },\n                    signal\n                })\n                : await this.remoteJson(`${this.config.openrouter.verifier_url}/submit_key`, {\n                    method: 'POST',\n                    headers: { 'content-type': 'application/json' },\n                    signal,\n                    body: JSON.stringify({\n                        station_id: evidence.station_id,\n                        api_key: lease.api_key,\n                        key_valid_till: evidence.key_valid_till,\n                        station_signature: evidence.station_signature,\n                        org_signature: evidence.org_signature\n                    })\n                });\n            throwIfAborted(signal);\n            if (verification?.status !== 'verified'\n                && !(hostVerify && verification?.status === 'verifier-unavailable'\n                    && verification.trustedStationFallback)) {\n                throw new Error('The trusted OA verifier rejected the ephemeral key.');\n            }\n            // Host policy approval is distinct from a verifier's approval. Never\n            // persist the key or expose raw verifier responses in wallet snapshots.\n            lease.verifierSubmitKeyProof = {\n                status: verification.status,\n                detail: verification.detail || null,\n                recordedAt: verification.recordedAt || new Date().toISOString(),\n                stationId: evidence.station_id,\n                ...(hostVerify && verification.trustedStationFallback\n                    ? { trustedStationFallback: structuredClone(verification.trustedStationFallback) } : {})\n            };"
                },
                {
                    "before": "                station_id: this.activeLease.verification?.station_id || null",
                    "after": "                station_id: this.activeLease.verification?.station_id || null,\n                verifierSubmitKeyProof: this.activeLease.verifierSubmitKeyProof\n                    ? structuredClone(this.activeLease.verifierSubmitKeyProof) : null"
                },
                {
                    "before": "        lease.inFlight += 1;",
                    "after": "        // Synchronous host check runs before checkout, so a later ban or changed\n        // policy cannot reuse a cached key or leak an in-flight reservation.\n        browserSdkOptions().assertProviderKey?.({\n            station_id: lease.verification?.station_id || null,\n            verifierSubmitKeyProof: lease.verifierSubmitKeyProof || null\n        });\n        lease.inFlight += 1;"
                },
                {
                    "before": "                    || payload.message\n                    || `HTTP ${response.status}`,",
                    "after": "                    || payload.message\n                    || payload.detail\n                    || `HTTP ${response.status}`,"
                }
            ]
        }
    ]
};
