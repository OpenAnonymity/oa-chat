# Sepolia service access

Sepolia can require one shared password configured in ZKAPI serverd with
`ZKAPI_TESTNET_PASSWORD`. Mainnet is unaffected. This is a test-group access
gate, not an OA account login or a wallet encryption password.

The wallet method selector exposes **Enter Sepolia password**, changing to
**Change Sepolia password** after validation. The password dialog keeps failed
attempts in place, clears rejected inputs, and can be canceled. A Send action
also asks for access before funding checks or provider inference, including
when its chat already owns a provider key. MetaMask deposits check access
before connecting or submitting. Send Ethereum fee preparation stays blocked
until access is validated, so an unauthenticated quote cannot publish payment
instructions. Background polling and recovery never open password dialogs.

The browser SDK keeps the accepted credential only in private in-memory
state. Reload or closing the tab requires it again. It never enters chatDB,
localStorage/sessionStorage, wallet journals, account sync, HTML templates,
build configuration or log records. The shared network logger redacts the
header even if an instrumented caller includes it. Dismissal aborts validation
so a late successful response cannot silently authenticate a canceled dialog.

Public `GET /health` advertises Sepolia's chain and the required flag. Missing,
wrong-chain or malformed discovery fails closed. `GET /v2/auth` validates
`X-ZKAPI-Testnet-Password`; the SDK attaches it only to the pinned Sepolia
protocol API's `/v2/` routes. Requests omit cookies and refuse redirects,
including through the configured same-origin deployment rewrite. RPC,
provider inference, account services, indexer and proving assets never receive
the password. No account identity is introduced into issuance or inference.

An HTTP 401 invalidates the in-memory credential and reports a fixed local
message. It never retries a protocol mutation automatically. Entering a new
password permits the existing SDK recovery flow to resume; the auth layer
does not delete pending proofs, deposits, leases or withdrawals. Password
rotation cannot retract a provider key already issued before rotation; its
ordinary expiry and settlement limits still apply. New operations are gated.

Cooperative withdrawal requires the server password. The SDK's unilateral
on-chain escape path retains its existing recovery behavior without adding a
service-password check; the password cannot authorize or block vault contract
transactions. Existing active-lease settlement prerequisites remain unchanged.

Validation covers header destination boundaries, Mainnet exclusion, same-origin
rewrite/direct fallback, redirect refusal, blocked funding/inference, no
automatic mutation replay, cancellation during validation, field clearing,
logger redaction and a Send with an already-active key. The server and CLI
have separate auth tests in their owning repositories.

The existing Sepolia service is password-protected as of 2026-09-29. See the
[deployment and verification record](SEPOLIA_AUTH_DEPLOYMENT_20260929.md) for
source pins, operational preservation and rollback details.
