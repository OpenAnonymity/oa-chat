// Preserve the host verification policy in the pinned successor SDK.
// All native quote, lease, evidence and origin checks remain before the hook.
export default {
    "name": "provider-verification-v2c",
    "revision": "30ca3b2b3540a9fbea297f57e329a262cb9d5adf",
    "files": [
        {
            "file": "sdk/configure.js",
            "beforeSha256": "a2dfae86e3e407dbf70a1dd94e506e5d13565ebd5057bb9e2c579e9f6b6ab07b",
            "afterSha256": "ec36de8432bca8f3509824d38dbda9b1a1147d6354eac657196612a25dfafdf9",
            "replacements": [
                {
                    "before": "provingKeysBaseUrlOverride: null });",
                    "after": "provingKeysBaseUrlOverride: null, verifyProviderKey: null, assertProviderKey: null });"
                },
                {
                    "before": "'provingKeysBaseUrlOverride'].includes(key)",
                    "after": "'provingKeysBaseUrlOverride', 'verifyProviderKey', 'assertProviderKey'].includes(key)"
                },
                {
                    "before": "    if (merged.mode !== 'browser') {",
                    "after": "    for (const name of ['verifyProviderKey', 'assertProviderKey']) {\n        if (merged[name] !== null && typeof merged[name] !== 'function') {\n            throw new TypeError(name + ' must be a provider verification function.');\n        }\n    }\n    if (merged.mode !== 'browser') {"
                }
            ]
        },
        {
            "file": "sdk/services/browserWalletRuntime.js",
            "beforeSha256": "b1cd64b976c909bc39b26ac1465da51c4fb3747abe4578826fe259371c1020d2",
            "afterSha256": "20e1f180a51f0a41ef79e28e63daeb03706ef36b1a308e9f62082d33d3fa2756",
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
