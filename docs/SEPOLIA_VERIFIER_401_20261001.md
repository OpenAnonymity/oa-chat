# Sepolia verifier 401 investigation, October 1

## Follow-up diagnosis and repair

The user subsequently supplied a staging Activity Timeline response containing
`{"detail":"Invalid org signature"}`. This confirms the org-signature rejection
for that request; it is consistent with Sepolia's observed verification failure,
whose original response body was not captured. The separate staging proving-key
error was directly reproduced from the browser's stale HTTP cache; see
[the cache repair](ZKAPI_PAYMENTS.md#proving-key-cache-integrity-failure-2026-10-01).

The shared fallback policy and zkAPI integration now require the explicitly
pinned station's valid local signature before continuing unverified. Unknown
stations, invalid station signatures, known bans and mismatched approvals block.
The SDK retains the verifier's error detail and projects the actual verification
status. This intentionally permits the operator-trusted station to continue when
the org signature is rejected; it does not repair or prove that org signature.
See [the trust exception](PRIVACY_MODEL.md#4-key-verification-verifier).

The original read-only investigation below records what was known before this
follow-up evidence; no live release is implied by these source changes.

## Original investigation

The live browser on `oa-wallet-eth-sepolia.vercel.app` reported
`BrowserWalletHttpError: HTTP 401` at `remoteJson → verifyLease` on
2026-10-01 at 06:24:27 UTC. The observed build was `UAG7TFYT`, core
`9452a7543be737d8d25b0d54c022ee6ca43966c0`, SDK `3342c958`.

This stack identifies the failed request as OA verifier `/submit_key`, before
activation of the new provider key or provider inference. The status alone
does not distinguish the verifier handler from an intervening gateway. A protected
Sepolia protocol request returning 401 instead takes the SDK's separate
`testnet_password_required` path. The screenshot's Auto Router label does not
identify the failing service.

The SDK hides the useful rejection detail. Its `remoteJson` error parser reads
`error_message` and `message`, including nested error objects, but not the
verifier's top-level `detail` string. Consequently several distinct verifier
rejections become the same `HTTP 401` message. The inspected verifier source
has 401 paths for invalid station signatures, invalid org signatures, and
OpenRouter ownership authorization failure after retries. The original response
body was no longer available in the browser's network buffer, so the exact
path is not yet established. Do not infer a signature failure, expired user
credential, or provider-account session failure from the generic message alone.

[Fresh read-only verifier diagnostics](https://github.com/OpenAnonymity/oa-verifier/actions/runs/36824831472)
collected at 06:27:14 UTC found both containers running, with no restarts since
02:31 UTC. The sanitized log summary includes TLS timeouts and 403 responses,
but its category allowlist omits signature failures. Healthy `/health` and a
station in `/broadcast` do not prove approval of this particular child key.

Next diagnostic: capture the response status and sanitized `detail` from the
next user-initiated `/submit_key` request. Never publish the request body,
provider key, signatures, private-note identifiers or password. Keep failed
verification closed; neither bypassing it nor resetting the wallet is a repair.
Any error-copy fix should map known verifier details to safe local wording and
retain the rejection and existing wallet recovery journal.

Source references:

- [Pinned SDK HTTP error parsing](https://github.com/OpenAnonymity/zkapi/blob/3342c95871e8422bb878ad40072687c241a68a5b/sdk/services/browserWalletRuntime.js#L815-L842)
- [Pinned SDK lease verification](https://github.com/OpenAnonymity/zkapi/blob/3342c95871e8422bb878ad40072687c241a68a5b/sdk/services/browserWalletRuntime.js#L1700-L1741)
- [Verifier response handling](https://github.com/OpenAnonymity/oa-verifier/blob/0a860d3/internal/server/handlers.go)
