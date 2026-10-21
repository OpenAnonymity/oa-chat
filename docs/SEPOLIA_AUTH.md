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

The browser SDK keeps the accepted credential in private in-memory state. The
host can also remember it in this browser, so a reload does not ask again
(`chat/zkapi/services/testnetPasswordMemory.mjs`):

- The dialog shows **Remember in this browser** (checked by default) only when
  `localStorage` accepts a write. Without usable storage the dialog is the
  original tab-only form and nothing is saved.
- An accepted password is saved in `localStorage` `oa-zkapi-sepolia-access-v1`
  as `{v: 1, service, password}`, where `service` is the Sepolia protocol
  server URL that accepted it. It is read only when the loaded deployment is
  Sepolia (chain 11155111) with that same server, so Mainnet and any other
  service never read or send it, and never remove it.
- All tabs share the key, so automatic removal (a 401 for the saved value, a
  failed save) deletes the entry only while it still holds exactly the
  service and password that tab read. A late 401 in one tab therefore keeps a
  replacement another tab saved meanwhile. Unchecking Remember clears this
  service's entry, whatever it holds.
- After the first successful wallet client start of a page, the saved value is
  offered once through the SDK (`ensureTestnetAccess({ interactive: true })`
  with a 20 s bound). This restoration never opens a dialog. A 401 deletes the
  entry; a network failure keeps it, and the next explicit action offers it
  again before any dialog.
- **Change Sepolia password** always opens the dialog, even with a saved
  value. Submitting with Remember checked replaces the entry; unchecked deletes
  it (the explicit clear) while this tab stays unlocked. Canceling leaves the
  entry. After a server 401 in the page, the next action opens the dialog
  rather than resending the saved value.
- A user Send waits for restoration before checking access and can open the
  dialog on that same action if the saved value was rejected. Direct wallet
  controls invoked during restoration can join the SDK's pending check; if
  it rejects, retrying the control opens the dialog.

The password never enters chatDB, sessionStorage, wallet journals, account
sync, HTML templates, build configuration or log records. The shared network
logger redacts the header even if an instrumented caller includes it.
Dismissal aborts validation so a late successful response cannot silently
authenticate a canceled dialog.

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

The browser wallet recovery compatibility patch targets auth SDK revision
`3342c95871e8422bb878ad40072687c241a68a5b`. Its exact source hashes and withdrawal
replacement preserve the cooperative-only auth check while binding recovery to
the selected operation. Changing the SDK pin requires reviewing and updating
this patch too; installation and builds reject a mismatched revision or hash.
The SDK captures the selected note before password entry and rejects a note
changed, removed or created while that dialog was open, before withdrawal work
starts. The recovery patch also rechecks that identity under the wallet lock.

Validation covers header destination boundaries, Mainnet exclusion, same-origin
rewrite/direct fallback, redirect refusal, blocked funding/inference, no
automatic mutation replay, cancellation during validation, field clearing,
logger redaction and a Send with an already-active key.
`test/zkapi/testnet-password-memory.test.mjs` drives the SDK's real
`TestnetPasswordAuth` through reload restoration, rotation, Change password,
explicit forgetting, a 401 after restore, network and storage failures,
Mainnet/other-service exclusion, and concurrent tabs (a delayed 401 after
another tab's replacement, other-service removals, failed saves). The server and CLI
have separate auth tests in their owning repositories.

The existing Sepolia service is password-protected as of 2026-09-29. See the
[deployment and verification record](SEPOLIA_AUTH_DEPLOYMENT_20260929.md) for
source pins, operational preservation and rollback details.
